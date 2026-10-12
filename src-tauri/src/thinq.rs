//! Cliente mínimo da API oficial LG ThinQ Connect (token pessoal / PAT).

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde_json::Value;

/// Chave pública usada pelo SDK oficial `thinqconnect`.
const API_KEY: &str = "v6GFvkweNo7DK7yD3ylIZ9w52aKBU0eJ7wLXkSR3";

pub struct ThinqClient {
    http: reqwest::Client,
    base: String,
    token: String,
    country: String,
    client_id: String,
}

fn region_for(country: &str) -> &'static str {
    match country {
        "BR" | "US" | "CA" | "MX" | "AR" | "CL" | "CO" | "PE" | "UY" | "PY" | "EC" | "VE" | "BO"
        | "CR" | "PA" | "GT" | "DO" | "PR" => "aic",
        "KR" | "JP" | "CN" | "TW" | "HK" | "IN" | "AU" | "NZ" | "SG" | "MY" | "TH" | "VN" | "PH"
        | "ID" => "kic",
        _ => "eic",
    }
}

impl ThinqClient {
    pub fn new(token: &str, country: &str, client_id: &str) -> Self {
        Self {
            http: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(15))
                .build()
                .expect("http client"),
            base: format!("https://api-{}.lgthinq.com", region_for(country)),
            token: token.to_string(),
            country: country.to_string(),
            client_id: client_id.to_string(),
        }
    }

    async fn request(&self, method: reqwest::Method, path: &str, body: Option<&Value>) -> Result<Value, String> {
        let message_id = URL_SAFE_NO_PAD.encode(uuid::Uuid::new_v4().as_bytes());
        let mut req = self
            .http
            .request(method.clone(), format!("{}{}", self.base, path))
            .bearer_auth(&self.token)
            .header("x-country", &self.country)
            .header("x-message-id", message_id)
            .header("x-client-id", &self.client_id)
            .header("x-api-key", API_KEY)
            .header("x-service-phase", "OP");
        if method == reqwest::Method::POST {
            req = req.header("x-conditional-control", "true");
        }
        if let Some(b) = body {
            req = req.json(b);
        }
        let res = req.send().await.map_err(|e| format!("Sem conexão com a LG: {e}"))?;
        let status = res.status();
        let json: Value = res.json().await.unwrap_or(Value::Null);
        if !status.is_success() {
            let code = json["error"]["code"].as_str().unwrap_or("");
            let msg = json["error"]["message"].as_str().unwrap_or("erro desconhecido");
            return Err(format!("{} ({code}): {msg}", status.as_u16()));
        }
        Ok(json["response"].clone())
    }

    pub async fn get(&self, path: &str) -> Result<Value, String> {
        self.request(reqwest::Method::GET, path, None).await
    }

    pub async fn post(&self, path: &str, body: &Value) -> Result<Value, String> {
        self.request(reqwest::Method::POST, path, Some(body)).await
    }
}
