//! The preview surface on Windows: a child window of the main window, below WebView2 in the
//! z-order, presenting through a flip-model swap chain. WebView2's background is transparent, so
//! the picture shows through the hole the page leaves for it while every page element still draws
//! on top. GDI painting is not used: Windows does not keep a child's GDI drawing under another
//! child window, while DWM composites a flip-model swap chain on its own.

use std::cell::RefCell;

use windows::core::{w, Interface};
use windows::Win32::Foundation::{E_FAIL, HMODULE, HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::Graphics::Direct3D::{
    D3D_DRIVER_TYPE_HARDWARE, D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_11_1,
};
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext1, ID3D11RenderTargetView, ID3D11Texture2D,
    D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_SDK_VERSION,
};
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_ALPHA_MODE_IGNORE, DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_FORMAT_UNKNOWN, DXGI_SAMPLE_DESC,
};
use windows::Win32::Graphics::Dxgi::{
    IDXGIAdapter, IDXGIDevice, IDXGIFactory2, IDXGIOutput, IDXGISwapChain1, DXGI_PRESENT,
    DXGI_SCALING_STRETCH, DXGI_SWAP_CHAIN_DESC1, DXGI_SWAP_CHAIN_FLAG,
    DXGI_SWAP_EFFECT_FLIP_DISCARD, DXGI_USAGE_RENDER_TARGET_OUTPUT,
};
use windows::Win32::Graphics::Gdi::ValidateRect;
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, RegisterClassExW, SetWindowPos, ShowWindow,
    HTTRANSPARENT, HWND_BOTTOM, SWP_NOACTIVATE, SWP_SHOWWINDOW, SW_HIDE, WINDOW_EX_STYLE,
    WM_ERASEBKGND, WM_NCHITTEST, WM_PAINT, WNDCLASSEXW, WS_CHILD,
};

use super::Viewport;

struct Surface {
    hwnd: HWND,
    device: ID3D11Device,
    context: ID3D11DeviceContext1,
    swap_chain: IDXGISwapChain1,
    target: Option<ID3D11RenderTargetView>,
    size: (u32, u32),
}

// created, drawn and destroyed only on the main thread, which owns the parent window
thread_local! {
    static SURFACE: RefCell<Option<Surface>> = const { RefCell::new(None) };
}

/// Creates the surface under `parent` if it does not exist yet. Must run on the main thread.
pub fn open(parent: HWND) -> windows::core::Result<()> {
    if SURFACE.with(|cell| cell.borrow().is_some()) {
        return Ok(());
    }
    let hwnd = create_window(parent)?;
    let surface = match create_graphics(hwnd) {
        Ok(surface) => surface,
        Err(error) => {
            unsafe {
                let _ = DestroyWindow(hwnd);
            }
            return Err(error);
        }
    };
    SURFACE.with(|cell| *cell.borrow_mut() = Some(surface));
    Ok(())
}

/// Moves the surface onto the picture and draws it, or hides it while there is none. Must run on
/// the main thread.
pub fn set_viewport(viewport: Viewport, pixels_per_css: f64) {
    SURFACE.with(|cell| {
        let mut surface = cell.borrow_mut();
        let Some(surface) = surface.as_mut() else {
            return;
        };
        if viewport.is_empty() {
            unsafe {
                let _ = ShowWindow(surface.hwnd, SW_HIDE);
            }
            return;
        }
        let (x, y, width, height) = viewport.device_rect(pixels_per_css);
        unsafe {
            // WebView2 keeps its own windows above; staying at the bottom keeps the page on top
            let _ = SetWindowPos(
                surface.hwnd,
                Some(HWND_BOTTOM),
                x,
                y,
                width,
                height,
                SWP_NOACTIVATE | SWP_SHOWWINDOW,
            );
        }
        let size = (width.max(1) as u32, height.max(1) as u32);
        if let Err(error) = surface.resize(size).and_then(|()| surface.draw()) {
            eprintln!("could not draw the preview surface: {error}");
        }
    });
}

fn create_window(parent: HWND) -> windows::core::Result<HWND> {
    unsafe {
        let instance = GetModuleHandleW(None)?;
        let class = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            lpfnWndProc: Some(surface_proc),
            hInstance: instance.into(),
            lpszClassName: w!("TuckPreviewSurface"),
            ..Default::default()
        };
        // a second registration fails harmlessly once the class exists
        RegisterClassExW(&class);
        CreateWindowExW(
            WINDOW_EX_STYLE(0),
            w!("TuckPreviewSurface"),
            w!(""),
            WS_CHILD,
            0,
            0,
            1,
            1,
            Some(parent),
            None,
            Some(instance.into()),
            None,
        )
    }
}

fn create_graphics(hwnd: HWND) -> windows::core::Result<Surface> {
    unsafe {
        let mut device = None;
        let mut context = None;
        D3D11CreateDevice(
            None::<&IDXGIAdapter>,
            D3D_DRIVER_TYPE_HARDWARE,
            HMODULE::default(),
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            Some(&[D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0]),
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            Some(&mut context),
        )?;
        let device: ID3D11Device = device.ok_or_else(|| windows::core::Error::from(E_FAIL))?;
        let context: ID3D11DeviceContext1 = context
            .ok_or_else(|| windows::core::Error::from(E_FAIL))?
            .cast()?;
        let factory: IDXGIFactory2 = device.cast::<IDXGIDevice>()?.GetAdapter()?.GetParent()?;
        let description = DXGI_SWAP_CHAIN_DESC1 {
            Width: 1,
            Height: 1,
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            BufferUsage: DXGI_USAGE_RENDER_TARGET_OUTPUT,
            BufferCount: 2,
            Scaling: DXGI_SCALING_STRETCH,
            SwapEffect: DXGI_SWAP_EFFECT_FLIP_DISCARD,
            AlphaMode: DXGI_ALPHA_MODE_IGNORE,
            ..Default::default()
        };
        let swap_chain = factory.CreateSwapChainForHwnd(
            &device,
            hwnd,
            &description,
            None,
            None::<&IDXGIOutput>,
        )?;
        Ok(Surface {
            hwnd,
            device,
            context,
            swap_chain,
            target: None,
            size: (1, 1),
        })
    }
}

impl Surface {
    fn resize(&mut self, size: (u32, u32)) -> windows::core::Result<()> {
        if size == self.size {
            return Ok(());
        }
        // the swap chain cannot resize while a view of its buffer is alive
        self.target = None;
        unsafe {
            self.context.ClearState();
            self.swap_chain.ResizeBuffers(
                0,
                size.0,
                size.1,
                DXGI_FORMAT_UNKNOWN,
                DXGI_SWAP_CHAIN_FLAG(0),
            )?;
        }
        self.size = size;
        Ok(())
    }

    // a test picture that makes misplacement, scaling and clipping easy to see in a screenshot
    fn draw(&mut self) -> windows::core::Result<()> {
        unsafe {
            if self.target.is_none() {
                let buffer: ID3D11Texture2D = self.swap_chain.GetBuffer(0)?;
                let mut target = None;
                self.device
                    .CreateRenderTargetView(&buffer, None, Some(&mut target))?;
                self.target = target;
            }
            let Some(target) = self.target.as_ref() else {
                return Err(E_FAIL.into());
            };
            let (width, height) = (self.size.0 as i32, self.size.1 as i32);
            self.context
                .ClearRenderTargetView(target, &[32.0 / 255.0, 33.0 / 255.0, 40.0 / 255.0, 1.0]);
            let cell = (width.min(height) / 9).max(8);
            let mut light = Vec::new();
            for row in 0..=(height / cell) {
                for column in 0..=(width / cell) {
                    if (row + column) % 2 == 0 {
                        light.push(RECT {
                            left: column * cell,
                            top: row * cell,
                            right: ((column + 1) * cell).min(width),
                            bottom: ((row + 1) * cell).min(height),
                        });
                    }
                }
            }
            self.context.ClearView(
                target,
                &[58.0 / 255.0, 60.0 / 255.0, 70.0 / 255.0, 1.0],
                Some(&light),
            );
            let border = 2;
            let accent = [
                RECT {
                    left: 0,
                    top: 0,
                    right: width,
                    bottom: border,
                },
                RECT {
                    left: 0,
                    top: height - border,
                    right: width,
                    bottom: height,
                },
                RECT {
                    left: 0,
                    top: 0,
                    right: border,
                    bottom: height,
                },
                RECT {
                    left: width - border,
                    top: 0,
                    right: width,
                    bottom: height,
                },
                RECT {
                    left: width / 2 - 1,
                    top: 0,
                    right: width / 2 + 1,
                    bottom: height,
                },
                RECT {
                    left: 0,
                    top: height / 2 - 1,
                    right: width,
                    bottom: height / 2 + 1,
                },
            ];
            self.context.ClearView(
                target,
                &[167.0 / 255.0, 139.0 / 255.0, 250.0 / 255.0, 1.0],
                Some(&accent),
            );
            self.swap_chain.Present(1, DXGI_PRESENT(0)).ok()
        }
    }
}

unsafe extern "system" fn surface_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match message {
        // the swap chain keeps its last picture; nothing to repaint
        WM_PAINT => {
            let _ = ValidateRect(Some(hwnd), None);
            LRESULT(0)
        }
        WM_ERASEBKGND => LRESULT(1),
        // the page above handles every pointer event
        WM_NCHITTEST => LRESULT(HTTRANSPARENT as isize),
        _ => DefWindowProcW(hwnd, message, wparam, lparam),
    }
}
