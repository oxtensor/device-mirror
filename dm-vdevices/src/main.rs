//! Device Mirror virtual-device pump.
//!
//! Listens on 127.0.0.1:3925 for length-prefixed JSON commands + binary payloads.
//! - {"cmd":"frame","width":W,"height":H,"format":"rgba"} + RGBA bytes
//! - {"cmd":"audio","sampleRate":48000,"channels":1} + s16le PCM
//! - {"cmd":"ping"}
//!
//! Camera frames are written into the embedded VCam shared memory (Device Mirror Camera).
//! Audio is played into the embedded Virtual Audio Driver speaker so the paired
//! Virtual Mic appears as a local microphone to other apps.

use anyhow::{bail, Context, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde::Deserialize;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use windows::core::PCWSTR;
use windows::Win32::Foundation::{CloseHandle, BOOL, HANDLE, INVALID_HANDLE_VALUE};
use windows::Win32::Security::{
    InitializeSecurityDescriptor, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES, SECURITY_DESCRIPTOR,
    SetSecurityDescriptorDacl,
};
use windows::Win32::System::Memory::{
    CreateFileMappingW, MapViewOfFile, OpenFileMappingW, UnmapViewOfFile, FILE_MAP_ALL_ACCESS,
    MEMORY_MAPPED_VIEW_ADDRESS, PAGE_READWRITE,
};

const SHM_NAME: &str = "Global\\vcam_frames";
const SHM_MAGIC: u32 = 0x4d414356;
const OUT_W: u32 = 1280;
const OUT_H: u32 = 720;
const HEADER_SIZE: usize = 32; // magic,w,h,seq,ready,pad[3] — matches VCam ShmHeader

#[derive(Deserialize)]
struct Cmd {
    cmd: String,
    #[serde(default)]
    width: u32,
    #[serde(default)]
    height: u32,
    #[serde(default)]
    format: String,
    #[serde(default)]
    sample_rate: u32,
    #[serde(default)]
    channels: u32,
}

struct FrameWriter {
    mapping: HANDLE,
    view: *mut u8,
    frame_size: usize,
}

unsafe impl Send for FrameWriter {}

impl FrameWriter {
    fn new() -> Result<Self> {
        let frame_size = (OUT_W * OUT_H * 3 / 2) as usize;
        let mapping_size = HEADER_SIZE + frame_size;

        let mut descriptor = SECURITY_DESCRIPTOR::default();
        unsafe {
            InitializeSecurityDescriptor(
                PSECURITY_DESCRIPTOR((&mut descriptor as *mut SECURITY_DESCRIPTOR).cast()),
                1,
            )?;
            SetSecurityDescriptorDacl(
                PSECURITY_DESCRIPTOR((&mut descriptor as *mut SECURITY_DESCRIPTOR).cast()),
                true,
                None,
                false,
            )?;
        }
        let attributes = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: (&mut descriptor as *mut SECURITY_DESCRIPTOR).cast(),
            bInheritHandle: false.into(),
        };
        let name: Vec<u16> = SHM_NAME.encode_utf16().chain(std::iter::once(0)).collect();
        let mapping = {
            let mut found = None;
            for _ in 0..40 {
                if let Ok(h) = unsafe {
                    OpenFileMappingW::<BOOL, PCWSTR>(0x000F001F, BOOL(0), PCWSTR(name.as_ptr()))
                }
                {
                    found = Some(h);
                    break;
                }
                thread::sleep(std::time::Duration::from_millis(150));
            }
            match found {
                Some(h) => Ok(h),
                None => unsafe {
                    CreateFileMappingW(
                        INVALID_HANDLE_VALUE,
                        Some(&attributes),
                        PAGE_READWRITE,
                        0,
                        mapping_size as u32,
                        PCWSTR(name.as_ptr()),
                    )
                },
            }
        }
        .context("CreateFileMappingW / OpenFileMappingW")?;

        let mapped = unsafe { MapViewOfFile(mapping, FILE_MAP_ALL_ACCESS, 0, 0, mapping_size) };
        if mapped.Value.is_null() {
            unsafe {
                let _ = CloseHandle(mapping);
            }
            bail!("MapViewOfFile failed");
        }
        let view = mapped.Value.cast::<u8>();
        unsafe {
            let magic = view as *mut u32;
            *magic = SHM_MAGIC;
            *magic.add(1) = OUT_W;
            *magic.add(2) = OUT_H;
            *magic.add(3) = 2;
            *magic.add(4) = 1;
            let y_size = (OUT_W * OUT_H) as usize;
            std::ptr::write_bytes(view.add(HEADER_SIZE), 0x90, y_size);
            std::ptr::write_bytes(view.add(HEADER_SIZE + y_size), 0x80, frame_size - y_size);
        }
        Ok(Self {
            mapping,
            view,
            frame_size,
        })
    }

    fn send_nv12(&mut self, nv12: &[u8]) -> Result<()> {
        if nv12.len() != self.frame_size {
            bail!("NV12 size {} != {}", nv12.len(), self.frame_size);
        }
        unsafe {
            let seq = self.view.add(12) as *mut AtomicU32;
            let ready = self.view.add(16) as *mut AtomicU32;
            (*seq).fetch_add(1, Ordering::AcqRel);
            std::ptr::copy_nonoverlapping(
                nv12.as_ptr(),
                self.view.add(HEADER_SIZE),
                nv12.len(),
            );
            (*seq).fetch_add(1, Ordering::Release);
            (*ready).store(1, Ordering::Release);
        }
        Ok(())
    }
}

impl Drop for FrameWriter {
    fn drop(&mut self) {
        unsafe {
            if !self.view.is_null() {
                let ready = self.view.add(16) as *mut AtomicU32;
                (*ready).store(0, Ordering::Release);
                let _ = UnmapViewOfFile(MEMORY_MAPPED_VIEW_ADDRESS {
                    Value: self.view.cast(),
                });
            }
            if !self.mapping.is_invalid() {
                let _ = CloseHandle(self.mapping);
            }
        }
    }
}

fn rgba_to_nv12(rgba: &[u8], w: u32, h: u32) -> Vec<u8> {
    // Nearest-neighbor scale to OUT_W x OUT_H then RGB->NV12
    let mut rgb = vec![0u8; (OUT_W * OUT_H * 3) as usize];
    for y in 0..OUT_H {
        for x in 0..OUT_W {
            let sx = (x as u64 * w as u64 / OUT_W as u64) as u32;
            let sy = (y as u64 * h as u64 / OUT_H as u64) as u32;
            let si = ((sy * w + sx) * 4) as usize;
            let di = ((y * OUT_W + x) * 3) as usize;
            if si + 2 < rgba.len() {
                rgb[di] = rgba[si];
                rgb[di + 1] = rgba[si + 1];
                rgb[di + 2] = rgba[si + 2];
            }
        }
    }
    let y_size = (OUT_W * OUT_H) as usize;
    let mut nv12 = vec![0u8; y_size + y_size / 2];
    for y in 0..OUT_H {
        for x in 0..OUT_W {
            let i = ((y * OUT_W + x) * 3) as usize;
            let r = rgb[i] as i32;
            let g = rgb[i + 1] as i32;
            let b = rgb[i + 2] as i32;
            let yy = ((66 * r + 129 * g + 25 * b + 128) >> 8) + 16;
            nv12[(y * OUT_W + x) as usize] = yy.clamp(0, 255) as u8;
        }
    }
    let mut uv = y_size;
    for y in (0..OUT_H).step_by(2) {
        for x in (0..OUT_W).step_by(2) {
            let i = ((y * OUT_W + x) * 3) as usize;
            let r = rgb[i] as i32;
            let g = rgb[i + 1] as i32;
            let b = rgb[i + 2] as i32;
            let uu = ((-38 * r - 74 * g + 112 * b + 128) >> 8) + 128;
            let vv = ((112 * r - 94 * g - 18 * b + 128) >> 8) + 128;
            nv12[uv] = uu.clamp(0, 255) as u8;
            nv12[uv + 1] = vv.clamp(0, 255) as u8;
            uv += 2;
        }
    }
    nv12
}

struct AudioOut {
    buffer: Arc<Mutex<Vec<f32>>>,
    _stream: cpal::Stream,
}

impl AudioOut {
    fn start() -> Result<Self> {
        let host = cpal::default_host();
        let device = host
            .output_devices()?
            .find(|d| {
                d.name()
                    .map(|n| n.to_lowercase().contains("virtual audio"))
                    .unwrap_or(false)
            })
            .or_else(|| host.default_output_device())
            .context("no output device")?;

        let config = device.default_output_config()?.config();
        let buffer = Arc::new(Mutex::new(Vec::<f32>::new()));
        let buf_cb = Arc::clone(&buffer);
        let channels = config.channels as usize;

        let stream = device.build_output_stream(
            &config,
            move |data: &mut [f32], _| {
                let mut guard = buf_cb.lock().unwrap();
                for frame in data.chunks_mut(channels) {
                    let sample = if guard.is_empty() {
                        0.0
                    } else {
                        guard.remove(0)
                    };
                    for s in frame.iter_mut() {
                        *s = sample;
                    }
                }
            },
            |err| eprintln!("audio err: {err}"),
            None,
        )?;
        stream.play()?;
        eprintln!(
            "audio -> {}",
            device.name().unwrap_or_else(|_| "unknown".into())
        );
        Ok(Self {
            buffer,
            _stream: stream,
        })
    }

    fn push_s16le(&self, bytes: &[u8]) {
        let mut guard = self.buffer.lock().unwrap();
        for chunk in bytes.chunks_exact(2) {
            let sample = i16::from_le_bytes([chunk[0], chunk[1]]) as f32 / 32768.0;
            guard.push(sample);
        }
        if guard.len() > 48000 {
            let overflow = guard.len() - 48000;
            guard.drain(0..overflow);
        }
    }
}

// cpal::Stream is !Send on some platforms; keep it on one audio thread via channel.
enum AudioMsg {
    Pcm(Vec<u8>),
}

fn spawn_audio_thread() -> std::sync::mpsc::Sender<AudioMsg> {
    let (tx, rx) = std::sync::mpsc::channel::<AudioMsg>();
    thread::spawn(move || {
        let audio = match AudioOut::start() {
            Ok(a) => a,
            Err(e) => {
                eprintln!("audio start failed: {e:#}");
                return;
            }
        };
        while let Ok(msg) = rx.recv() {
            match msg {
                AudioMsg::Pcm(bytes) => audio.push_s16le(&bytes),
            }
        }
    });
    tx
}

fn read_exact(stream: &mut TcpStream, n: usize) -> Result<Vec<u8>> {
    let mut buf = vec![0u8; n];
    stream.read_exact(&mut buf)?;
    Ok(buf)
}

fn handle_client(
    mut stream: TcpStream,
    writer: Arc<Mutex<FrameWriter>>,
    audio_tx: std::sync::mpsc::Sender<AudioMsg>,
) -> Result<()> {
    stream.set_nodelay(true)?;
    loop {
        let len_buf = match read_exact(&mut stream, 4) {
            Ok(b) => b,
            Err(_) => break,
        };
        let header_len = u32::from_le_bytes(len_buf.try_into().unwrap()) as usize;
        if header_len == 0 || header_len > 1_000_000 {
            bail!("bad header len");
        }
        let header_bytes = read_exact(&mut stream, header_len)?;
        let cmd: Cmd = serde_json::from_slice(&header_bytes)?;
        match cmd.cmd.as_str() {
            "ping" => {
                stream.write_all(b"ok")?;
            }
            "frame" => {
                let payload_len_buf = read_exact(&mut stream, 4)?;
                let payload_len = u32::from_le_bytes(payload_len_buf.try_into().unwrap()) as usize;
                let rgba = read_exact(&mut stream, payload_len)?;
                let w = if cmd.width > 0 { cmd.width } else { 640 };
                let h = if cmd.height > 0 { cmd.height } else { 480 };
                let nv12 = if cmd.format == "nv12" {
                    rgba
                } else {
                    rgba_to_nv12(&rgba, w, h)
                };
                writer.lock().unwrap().send_nv12(&nv12)?;
            }
            "audio" => {
                let payload_len_buf = read_exact(&mut stream, 4)?;
                let payload_len = u32::from_le_bytes(payload_len_buf.try_into().unwrap()) as usize;
                let pcm = read_exact(&mut stream, payload_len)?;
                let _ = audio_tx.send(AudioMsg::Pcm(pcm));
            }
            other => eprintln!("unknown cmd {other}"),
        }
    }
    Ok(())
}

fn main() -> Result<()> {
    let writer = Arc::new(Mutex::new(FrameWriter::new()?));
    let audio_tx = spawn_audio_thread();
    let listener = TcpListener::bind("127.0.0.1:3925")?;
    eprintln!("dm-vdevices listening on 127.0.0.1:3925");
    for stream in listener.incoming() {
        let stream = stream?;
        let w = Arc::clone(&writer);
        let tx = audio_tx.clone();
        thread::spawn(move || {
            if let Err(e) = handle_client(stream, w, tx) {
                eprintln!("client error: {e:#}");
            }
        });
    }
    Ok(())
}
