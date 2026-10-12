#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod thinq;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, PhysicalPosition, Rect, State, WebviewWindow, WindowEvent,
};
use thinq::ThinqClient;

#[derive(Serialize, Deserialize, Default, Clone)]
struct Config {
    token: String,
    country: String,
    client_id: String,
    device_id: String,
}

struct AppState {
    config: Mutex<Config>,
    config_path: PathBuf,
    /// Momento em que o popup foi escondido por perder o foco. Usado para que o
    /// clique no ícone do tray (que tira o foco) não reabra o popup na hora.
    hidden_at: Mutex<Option<Instant>>,
    tray: Mutex<Option<TrayIcon>>,
}

impl AppState {
    fn client(&self) -> Result<(ThinqClient, String), String> {
        let c = self.config.lock().unwrap().clone();
        if c.token.is_empty() {
            return Err("Token não configurado".into());
        }
        Ok((ThinqClient::new(&c.token, &c.country, &c.client_id), c.device_id))
    }

    fn save(&self) -> Result<(), String> {
        let c = self.config.lock().unwrap();
        if let Some(dir) = self.config_path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        std::fs::write(&self.config_path, serde_json::to_string_pretty(&*c).unwrap()).map_err(|e| e.to_string())
    }
}

#[tauri::command]
fn get_config(state: State<AppState>) -> Value {
    let c = state.config.lock().unwrap();
    json!({ "hasToken": !c.token.is_empty(), "country": c.country, "deviceId": c.device_id })
}

/// Valida o token listando os aparelhos e salva a configuração.
#[tauri::command]
async fn save_config(state: State<'_, AppState>, token: String, country: String) -> Result<Value, String> {
    let token = token.trim().to_string();
    let country = country.trim().to_uppercase();
    let client_id = state.config.lock().unwrap().client_id.clone();
    let devices = ThinqClient::new(&token, &country, &client_id).get("/devices").await?;
    let ac = devices
        .as_array()
        .and_then(|list| list.iter().find(|d| d["deviceInfo"]["deviceType"] == "DEVICE_AIR_CONDITIONER"))
        .ok_or("Nenhum ar-condicionado encontrado nesta conta")?;
    {
        let mut c = state.config.lock().unwrap();
        c.token = token;
        c.country = country;
        c.device_id = ac["deviceId"].as_str().unwrap_or_default().to_string();
    }
    state.save()?;
    Ok(ac.clone())
}

#[tauri::command]
async fn get_device(state: State<'_, AppState>) -> Result<Value, String> {
    let (client, device_id) = state.client()?;
    let devices = client.get("/devices").await?;
    let info = devices
        .as_array()
        .and_then(|l| l.iter().find(|d| d["deviceId"] == device_id.as_str()))
        .cloned()
        .unwrap_or(Value::Null);
    let profile = client.get(&format!("/devices/{device_id}/profile")).await?;
    let energy = client.get(&format!("/devices/energy/{device_id}/profile")).await.unwrap_or(Value::Null);
    Ok(json!({ "info": info, "profile": profile, "energyProfile": energy }))
}

#[tauri::command]
async fn get_state(state: State<'_, AppState>) -> Result<Value, String> {
    let (client, device_id) = state.client()?;
    client.get(&format!("/devices/{device_id}/state")).await
}

#[tauri::command]
async fn control(state: State<'_, AppState>, payload: Value) -> Result<Value, String> {
    let (client, device_id) = state.client()?;
    client.post(&format!("/devices/{device_id}/control"), &payload).await
}

#[tauri::command]
async fn energy_usage(state: State<'_, AppState>, period: String, start: String, end: String) -> Result<Value, String> {
    let (client, device_id) = state.client()?;
    client
        .get(&format!(
            "/devices/energy/{device_id}/usage?property=energyUsage&period={period}&startDate={start}&endDate={end}"
        ))
        .await
}

/// O ícone do tray é desenhado num canvas no front-end (temperatura em texto)
/// e chega aqui como RGBA.
#[tauri::command]
fn set_tray(state: State<AppState>, rgba: Vec<u8>, width: u32, height: u32, tooltip: String) -> Result<(), String> {
    if let Some(tray) = state.tray.lock().unwrap().as_ref() {
        tray.set_icon(Some(Image::new_owned(rgba, width, height))).map_err(|e| e.to_string())?;
        tray.set_tooltip(Some(tooltip)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn hide_popup(window: WebviewWindow) {
    let _ = window.hide();
}

#[tauri::command]
fn quit(app: AppHandle) {
    app.exit(0);
}

/// Posiciona o popup logo acima (ou abaixo) do ícone, sem sair da área útil do monitor.
fn place_near_tray(window: &WebviewWindow, rect: &Rect) {
    let scale = window.scale_factor().unwrap_or(1.0);
    let icon_pos = rect.position.to_physical::<i32>(scale);
    let icon_size = rect.size.to_physical::<u32>(scale);
    let Ok(win) = window.outer_size() else { return };
    let (w, h) = (win.width as i32, win.height as i32);
    let gap = (8.0 * scale) as i32;
    let center_x = icon_pos.x + icon_size.width as i32 / 2;
    let monitor = window
        .app_handle()
        .monitor_from_point(center_x as f64, icon_pos.y as f64)
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten());
    let (mut x, mut y) = (center_x - w / 2, icon_pos.y - h - gap);
    if let Some(m) = monitor {
        let area = m.work_area();
        let (ax, ay) = (area.position.x, area.position.y);
        let (aw, ah) = (area.size.width as i32, area.size.height as i32);
        // Barra de tarefas no topo: abre para baixo.
        if icon_pos.y < ay + ah / 2 {
            y = icon_pos.y + icon_size.height as i32 + gap;
        }
        x = x.clamp(ax + gap, ax + aw - w - gap);
        y = y.clamp(ay + gap, ay + ah - h - gap);
    }
    let _ = window.set_position(PhysicalPosition::new(x, y));
}

fn toggle_popup(app: &AppHandle, rect: &Rect) {
    let Some(window) = app.get_webview_window("main") else { return };
    let state = app.state::<AppState>();
    let just_hidden = state
        .hidden_at
        .lock()
        .unwrap()
        .map_or(false, |t| t.elapsed() < Duration::from_millis(300));
    if window.is_visible().unwrap_or(false) || just_hidden {
        let _ = window.hide();
        return;
    }
    place_near_tray(&window, rect);
    let _ = window.show();
    let _ = window.set_focus();
    let _ = window.emit_to("main", "popup-shown", ());
}

fn show_popup_default(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if let Ok(Some(m)) = window.primary_monitor() {
            let area = m.work_area();
            if let Ok(size) = window.outer_size() {
                let x = area.position.x + area.size.width as i32 - size.width as i32 - 12;
                let y = area.position.y + area.size.height as i32 - size.height as i32 - 12;
                let _ = window.set_position(PhysicalPosition::new(x, y));
            }
        }
        let _ = window.show();
        let _ = window.set_focus();
        let _ = window.emit_to("main", "popup-shown", ());
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_popup_default(app)))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(|app| {
            let config_path = app.path().app_config_dir()?.join("config.json");
            let mut config: Config = std::fs::read_to_string(&config_path)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default();
            if config.country.is_empty() {
                config.country = "BR".into();
            }
            let new_client_id = config.client_id.is_empty();
            if new_client_id {
                config.client_id = format!("aircond-tray-{}", uuid::Uuid::new_v4());
            }
            let state = AppState {
                config: Mutex::new(config),
                config_path,
                hidden_at: Mutex::new(None),
                tray: Mutex::new(None),
            };
            if new_client_id {
                let _ = state.save();
            }
            app.manage(state);

            let open = MenuItem::with_id(app, "open", "Abrir", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Sair", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;
            let tray = TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Ar Condicionado")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_popup_default(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        rect,
                        ..
                    } = event
                    {
                        toggle_popup(tray.app_handle(), &rect);
                    }
                })
                .build(app)?;
            *app.state::<AppState>().tray.lock().unwrap() = Some(tray);

            // Sem token: abre o popup direto na tela de configuração.
            if !app.state::<AppState>().config.lock().unwrap().token.is_empty() {
                return Ok(());
            }
            show_popup_default(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::Focused(false) = event {
                if window.label() == "main" && window.is_visible().unwrap_or(false) {
                    let _ = window.hide();
                    *window.app_handle().state::<AppState>().hidden_at.lock().unwrap() = Some(Instant::now());
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            save_config,
            get_device,
            get_state,
            control,
            energy_usage,
            set_tray,
            hide_popup,
            quit
        ])
        .run(tauri::generate_context!())
        .expect("erro ao iniciar o app");
}
