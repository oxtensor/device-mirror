#include "framework.h"
#include "tools.h"
#include "Registrar.h"
#include "../Common/Contract.h"

#include <shellapi.h>
#include <aclapi.h>
#include <sddl.h>

#pragma comment(lib, "advapi32")
#pragma comment(lib, "shell32")

#define MAX_LOADSTRING 100

HINSTANCE _instance;
WCHAR _title[MAX_LOADSTRING];
WCHAR _windowClass[MAX_LOADSTRING];
wil::com_ptr_nothrow<IMFVirtualCamera> _vcam;
DWORD _vcamCookie;
bool _headless = false;

ATOM MyRegisterClass(HINSTANCE hInstance);
HWND InitInstance(HINSTANCE, int);
LRESULT CALLBACK WndProc(HWND, UINT, WPARAM, LPARAM);
INT_PTR CALLBACK About(HWND, UINT, WPARAM, LPARAM);
HRESULT RegisterVirtualCamera();
HRESULT UnregisterVirtualCamera();
HRESULT EnsureSourceRegistered();
HRESULT RegisterSourceDll(const wchar_t* dllPath);
bool IsSourceRegistered();
bool IsProcessElevated();
HRESULT RelaunchElevatedAndWait(const wchar_t* args);
void GetInstallDir(wchar_t* out, size_t cch);
bool CopyToInstallDir(const wchar_t* fileName, wchar_t* destPath, size_t cch);
void GrantWorldRead(const wchar_t* dir);

int APIENTRY wWinMain(_In_ HINSTANCE hInstance, _In_opt_ HINSTANCE hPrevInstance, _In_ LPWSTR lpCmdLine, _In_ int nCmdShow)
{
	UNREFERENCED_PARAMETER(hPrevInstance);
	_headless = lpCmdLine && (wcsstr(lpCmdLine, L"/headless") || wcsstr(lpCmdLine, L"/register-only"));
	const bool registerOnly = lpCmdLine && wcsstr(lpCmdLine, L"/register-only");

	WinTraceRegister();
	WINTRACE(L"WinMain starting '%s'", GetCommandLineW());
	_CrtSetReportMode(_CRT_WARN, _CRTDBG_MODE_DEBUG);

	wil::SetResultLoggingCallback([](wil::FailureInfo const& failure) noexcept
		{
			wchar_t str[2048];
			if (SUCCEEDED(wil::GetFailureLogString(str, _countof(str), failure)))
			{
				WinTrace(2, 0, str);
				if (!_headless)
				{
					TaskDialog(nullptr, nullptr, _title, L"A fatal error has occured. Press OK to terminate.", str, TDCBF_OK_BUTTON, TD_WARNING_ICON, nullptr);
				}
			}
		});

	auto hrEnsure = EnsureSourceRegistered();
	if (registerOnly)
	{
		WINTRACE(L"register-only complete hr=0x%08X", hrEnsure);
		WinTraceUnregister();
		return FAILED(hrEnsure) ? 1 : 0;
	}

	LoadStringW(hInstance, IDS_APP_TITLE, _title, MAX_LOADSTRING);
	lstrcpyW(_title, vcam::contract::FriendlyName);
	LoadStringW(hInstance, IDC_VCAM, _windowClass, MAX_LOADSTRING);
	MyRegisterClass(hInstance);
	auto hwnd = InitInstance(hInstance, _headless ? SW_HIDE : nCmdShow);
	if (hwnd)
	{
		winrt::init_apartment();
		if (SUCCEEDED(MFStartup(MF_VERSION)))
		{
			TASKDIALOGCONFIG config{};
			config.cbSize = sizeof(TASKDIALOGCONFIG);
			config.hInstance = hInstance;
			config.hwndParent = hwnd;
			config.pszWindowTitle = _title;
			config.dwCommonButtons = TDCBF_CLOSE_BUTTON;
			auto hr = RegisterVirtualCamera();
			if (SUCCEEDED(hr))
			{
				if (_headless)
				{
					MSG msg;
					while (GetMessage(&msg, nullptr, 0, 0))
					{
						TranslateMessage(&msg);
						DispatchMessage(&msg);
					}
				}
				else
				{
					config.pszMainInstruction = L"Device Mirror Camera is running.";
					config.pszContent = L"Apps can now select “Device Mirror Camera”. Close this window to unregister.";
					config.pszMainIcon = TD_INFORMATION_ICON;
					TaskDialogIndirect(&config, nullptr, nullptr, nullptr);
				}

				UnregisterVirtualCamera();
			}
			else if (!_headless)
			{
				config.pszMainInstruction = L"VCam could not start.";
				wchar_t text[1024];
				wchar_t errorText[256]{};
				FormatMessage(FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS, nullptr, hr, 0, errorText, _countof(errorText), nullptr);
				wsprintf(text, L"Error 0x%08X: %s\n\nApprove the admin prompt so Device Mirror can register VCamSource.dll, then try again.", hr, errorText);
				config.pszContent = text;
				config.pszMainIcon = TD_ERROR_ICON;
				TaskDialogIndirect(&config, nullptr, nullptr, nullptr);
			}

			_vcam.reset();
			MFShutdown();
		}
	}

	_CrtDumpMemoryLeaks();
	WINTRACE(L"WinMain exiting '%s'", GetCommandLineW());
	WinTraceUnregister();
	return 0;
}

void GetInstallDir(wchar_t* out, size_t cch)
{
	wchar_t programData[MAX_PATH]{};
	if (!GetEnvironmentVariableW(L"ProgramData", programData, MAX_PATH))
		wcscpy_s(programData, L"C:\\ProgramData");
	swprintf_s(out, cch, L"%s\\DeviceMirror", programData);
	CreateDirectoryW(out, nullptr);
}

bool CopyToInstallDir(const wchar_t* fileName, wchar_t* destPath, size_t cch)
{
	wchar_t installDir[MAX_PATH]{};
	GetInstallDir(installDir, _countof(installDir));
	swprintf_s(destPath, cch, L"%s\\%s", installDir, fileName);

	wchar_t moduleDir[MAX_PATH]{};
	GetModuleFileNameW(nullptr, moduleDir, MAX_PATH);
	auto* slash = wcsrchr(moduleDir, L'\\');
	if (slash) *slash = 0;

	wchar_t src[MAX_PATH]{};
	swprintf_s(src, L"%s\\%s", moduleDir, fileName);
	if (GetFileAttributesW(src) == INVALID_FILE_ATTRIBUTES)
		return GetFileAttributesW(destPath) != INVALID_FILE_ATTRIBUTES;

	if (_wcsicmp(src, destPath) != 0)
		CopyFileW(src, destPath, FALSE);
	return GetFileAttributesW(destPath) != INVALID_FILE_ATTRIBUTES;
}

void GrantWorldRead(const wchar_t* dir)
{
	PSECURITY_DESCRIPTOR sd = nullptr;
	if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(
		L"D:(A;OICI;GRGX;;;WD)(A;OICI;FA;;;BA)(A;OICI;FA;;;SY)",
		SDDL_REVISION_1, &sd, nullptr))
		return;
	SetFileSecurityW(dir, DACL_SECURITY_INFORMATION, sd);
	LocalFree(sd);
}

bool IsProcessElevated()
{
	HANDLE token = nullptr;
	if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token))
		return false;
	TOKEN_ELEVATION elev{};
	DWORD size = 0;
	const bool ok = GetTokenInformation(token, TokenElevation, &elev, sizeof(elev), &size) && elev.TokenIsElevated;
	CloseHandle(token);
	return ok;
}

bool IsSourceRegistered()
{
	auto clsid = GUID_ToStringW(vcam::contract::SourceClsid);
	wchar_t path[512]{};
	swprintf_s(path, L"Software\\Classes\\CLSID\\%s\\InprocServer32", clsid.c_str());
	HKEY key = nullptr;
	if (RegOpenKeyExW(HKEY_LOCAL_MACHINE, path, 0, KEY_READ, &key) != ERROR_SUCCESS)
		return false;
	wchar_t dll[MAX_PATH]{};
	DWORD type = 0, bytes = sizeof(dll);
	const auto st = RegQueryValueExW(key, nullptr, nullptr, &type, reinterpret_cast<LPBYTE>(dll), &bytes);
	RegCloseKey(key);
	return st == ERROR_SUCCESS && dll[0] && GetFileAttributesW(dll) != INVALID_FILE_ATTRIBUTES;
}

HRESULT RegisterSourceDll(const wchar_t* dllPath)
{
	auto module = LoadLibraryW(dllPath);
	if (!module)
		return HRESULT_FROM_WIN32(GetLastError());
	using DllRegisterServerFn = HRESULT(STDAPICALLTYPE*)();
	auto fn = reinterpret_cast<DllRegisterServerFn>(GetProcAddress(module, "DllRegisterServer"));
	HRESULT hr = fn ? fn() : E_FAIL;
	FreeLibrary(module);
	return hr;
}

HRESULT RelaunchElevatedAndWait(const wchar_t* args)
{
	wchar_t exe[MAX_PATH]{};
	GetModuleFileNameW(nullptr, exe, MAX_PATH);
	SHELLEXECUTEINFOW sei{};
	sei.cbSize = sizeof(sei);
	sei.fMask = SEE_MASK_NOCLOSEPROCESS;
	sei.lpVerb = L"runas";
	sei.lpFile = exe;
	sei.lpParameters = args;
	sei.nShow = SW_HIDE;
	if (!ShellExecuteExW(&sei))
		return HRESULT_FROM_WIN32(GetLastError());
	if (sei.hProcess)
	{
		WaitForSingleObject(sei.hProcess, 30000);
		DWORD code = 1;
		GetExitCodeProcess(sei.hProcess, &code);
		CloseHandle(sei.hProcess);
		return code == 0 ? S_OK : E_FAIL;
	}
	return E_FAIL;
}

HRESULT EnsureSourceRegistered()
{
	wchar_t dllPath[MAX_PATH]{};
	if (!CopyToInstallDir(L"VCamSource.dll", dllPath, _countof(dllPath)))
		RETURN_HR_MSG(HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND), "VCamSource.dll not found next to VCamRegistrar.exe");

	wchar_t installDir[MAX_PATH]{};
	GetInstallDir(installDir, _countof(installDir));
	GrantWorldRead(installDir);

	wchar_t registrarDest[MAX_PATH]{};
	CopyToInstallDir(L"VCamRegistrar.exe", registrarDest, _countof(registrarDest));

	if (IsSourceRegistered())
		return S_OK;

	auto hr = RegisterSourceDll(dllPath);
	if (SUCCEEDED(hr) && IsSourceRegistered())
		return S_OK;

	if (!IsProcessElevated())
	{
		hr = RelaunchElevatedAndWait(L"/register-only");
		if (SUCCEEDED(hr) && IsSourceRegistered())
			return S_OK;
	}

	RETURN_IF_FAILED_MSG(hr, "Cannot register VCamSource.dll (needs admin once)");
	if (!IsSourceRegistered()) RETURN_HR_MSG(E_FAIL, "VCamSource.dll still not registered");
	return S_OK;
}

HRESULT RegisterVirtualCamera()
{
	RETURN_IF_FAILED(EnsureSourceRegistered());

	auto clsid = GUID_ToStringW(vcam::contract::SourceClsid);
	RETURN_IF_FAILED_MSG(MFCreateVirtualCamera(
		MFVirtualCameraType_SoftwareCameraSource,
		MFVirtualCameraLifetime_Session,
		MFVirtualCameraAccess_CurrentUser,
		_title,
		clsid.c_str(),
		nullptr,
		0,
		&_vcam),
		"Failed to create virtual camera");

	WINTRACE(L"RegisterVirtualCamera '%s' ok", clsid.c_str());
	HRESULT startHr = E_FAIL;
	for (int attempt = 0; attempt < 8; attempt++)
	{
		startHr = _vcam->Start(nullptr);
		if (SUCCEEDED(startHr))
			break;
		Sleep(400);
	}
	RETURN_IF_FAILED_MSG(startHr, "Cannot start VCam");
	WINTRACE(L"VCam was started");
	return S_OK;
}

HRESULT UnregisterVirtualCamera()
{
	if (!_vcam)
		return S_OK;

	auto hr = _vcam->Remove();
	WINTRACE(L"Remove VCam hr:0x%08X", hr);
	return S_OK;
}

ATOM MyRegisterClass(HINSTANCE instance)
{
	WNDCLASSEXW wcex{};
	wcex.cbSize = sizeof(WNDCLASSEX);
	wcex.style = CS_HREDRAW | CS_VREDRAW;
	wcex.lpfnWndProc = WndProc;
	wcex.hInstance = instance;
	wcex.hIcon = LoadIcon(instance, MAKEINTRESOURCE(IDI_VCAM));
	wcex.hCursor = LoadCursor(nullptr, IDC_ARROW);
	wcex.hbrBackground = (HBRUSH)(COLOR_WINDOW + 1);
	wcex.lpszMenuName = MAKEINTRESOURCEW(IDC_VCAM);
	wcex.lpszClassName = _windowClass;
	wcex.hIconSm = LoadIcon(wcex.hInstance, MAKEINTRESOURCE(IDI_SMALL));
	return RegisterClassExW(&wcex);
}

HWND InitInstance(HINSTANCE instance, int cmd)
{
	_instance = instance;
	if (cmd == SW_HIDE)
	{
		// Message-only window: stays alive for session camera, no UI for Meet/Chrome users to close.
		return CreateWindowExW(0, _windowClass, _title, 0, 0, 0, 0, 0, HWND_MESSAGE, nullptr, instance, nullptr);
	}
	auto hwnd = CreateWindowW(_windowClass, _title, WS_OVERLAPPEDWINDOW, 0, 0, 600, 400, nullptr, nullptr, instance, nullptr);
	if (!hwnd)
		return nullptr;

	CenterWindow(hwnd);
	ShowWindow(hwnd, cmd);
	UpdateWindow(hwnd);
	return hwnd;
}

LRESULT CALLBACK WndProc(HWND hwnd, UINT message, WPARAM wParam, LPARAM lParam)
{
	switch (message)
	{
	case WM_COMMAND:
	{
		auto wmId = LOWORD(wParam);
		switch (wmId)
		{
		case IDM_ABOUT:
			DialogBox(_instance, MAKEINTRESOURCE(IDD_ABOUTBOX), hwnd, About);
			break;

		case IDM_EXIT:
			DestroyWindow(hwnd);
			break;
		default:
			return DefWindowProc(hwnd, message, wParam, lParam);
		}
	}
	break;

	case WM_PAINT:
	{
		PAINTSTRUCT ps;
		auto hdc = BeginPaint(hwnd, &ps);
		EndPaint(hwnd, &ps);
	}
	break;

	case WM_DESTROY:
		PostQuitMessage(0);
		break;

	default:
		return DefWindowProc(hwnd, message, wParam, lParam);
	}
	return 0;
}

INT_PTR CALLBACK About(HWND hwnd, UINT message, WPARAM wParam, LPARAM lParam)
{
	UNREFERENCED_PARAMETER(lParam);
	switch (message)
	{
	case WM_INITDIALOG:
		return (INT_PTR)TRUE;

	case WM_COMMAND:
		if (LOWORD(wParam) == IDOK || LOWORD(wParam) == IDCANCEL)
		{
			EndDialog(hwnd, LOWORD(wParam));
			return (INT_PTR)TRUE;
		}
		break;
	}
	return (INT_PTR)FALSE;
}
