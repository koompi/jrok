//! Tunnel options, in the jrok CLI's own argument vocabulary, so the deploy
//! worker builds them exactly as it does for `jrok` (lib/jrokEdges.ts).

use std::collections::HashMap;

pub const DEFAULT_SERVER: &str = "https://tunnel.koompi.cloud";

#[derive(Clone, Debug)]
pub struct TunnelConfig {
    pub server_url: url::Url,
    pub server_host: String,
    pub server_port: u16,
    pub tls: bool,
    /// Where to connect instead of the server's name (`--edge`); TLS and Host
    /// stay on the server's name.
    pub edge: Option<String>,
    pub local_host: String,
    pub local_port: u16,
    pub domain: String,
    pub group: bool,
    pub instance_id: Option<String>,
    pub organization_id: Option<String>,
    /// "allowlist" / "blocklist", with its list, as the CLI derives them.
    pub ip_mode: Option<String>,
    pub allowed_ips: Vec<String>,
    pub blocked_ips: Vec<String>,
    pub tcp: bool,
    pub force_new: bool,
    pub auth: String,
}

/// `--key value` pairs and bare `--flag`s, as the CLI reads them.
fn parse_pairs(args: &[String]) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        if let Some(key) = arg.strip_prefix("--") {
            match args.get(i + 1) {
                Some(value) if !value.starts_with("--") => {
                    map.insert(key.to_string(), value.clone());
                    i += 1;
                }
                _ => {
                    map.insert(key.to_string(), "true".to_string());
                }
            }
        } else if arg == "-p" {
            if let Some(value) = args.get(i + 1) {
                map.insert("port".to_string(), value.clone());
                i += 1;
            }
        }
        i += 1;
    }
    map
}

fn list(value: Option<&String>) -> Vec<String> {
    value
        .map(|v| v.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect())
        .unwrap_or_default()
}

impl TunnelConfig {
    /// From CLI-style arguments; the key from `--auth`, else JROK_AUTH / JROK_API_KEY.
    pub fn from_args(args: &[String]) -> Result<TunnelConfig, String> {
        let a = parse_pairs(args);
        let server = a.get("server").cloned().unwrap_or_else(|| DEFAULT_SERVER.to_string());
        let server_url = url::Url::parse(&server).map_err(|e| format!("--server {server}: {e}"))?;
        let tls = match server_url.scheme() {
            "https" | "wss" => true,
            "http" | "ws" => false,
            other => return Err(format!("--server: unsupported scheme {other}")),
        };
        let server_host = server_url.host_str().ok_or("--server has no host")?.to_string();
        let server_port = server_url.port().unwrap_or(if tls { 443 } else { 80 });
        let local_port: u16 = a
            .get("port")
            .ok_or("--port is required")?
            .parse()
            .map_err(|_| "--port must be a number".to_string())?;
        let domain = a.get("domain").cloned().ok_or("--domain is required")?;
        let auth = a
            .get("auth")
            .cloned()
            .or_else(|| std::env::var("JROK_AUTH").ok())
            .or_else(|| std::env::var("JROK_API_KEY").ok())
            .filter(|k| !k.is_empty())
            .ok_or("no API key: set JROK_AUTH")?;
        // As the CLI: --restrict or --allow-ip is an allowlist; --block-ip, if
        // given, replaces it with a blocklist.
        let (mut ip_mode, mut allowed_ips, mut blocked_ips) = (None, Vec::new(), Vec::new());
        if a.contains_key("restrict") {
            ip_mode = Some("allowlist".to_string());
        }
        if a.contains_key("allow-ip") {
            ip_mode = Some("allowlist".to_string());
            allowed_ips = list(a.get("allow-ip"));
        }
        if a.contains_key("block-ip") {
            ip_mode = Some("blocklist".to_string());
            allowed_ips = Vec::new();
            blocked_ips = list(a.get("block-ip"));
        }
        Ok(TunnelConfig {
            server_url,
            server_host,
            server_port,
            tls,
            edge: a.get("edge").cloned().filter(|e| !e.is_empty()),
            local_host: a
                .get("host")
                .cloned()
                .or_else(|| std::env::var("JROK_HOST").ok())
                .unwrap_or_else(|| "localhost".to_string()),
            local_port,
            domain,
            group: a.contains_key("group"),
            instance_id: a.get("instance-id").cloned(),
            organization_id: a.get("org").cloned(),
            ip_mode,
            allowed_ips,
            blocked_ips,
            tcp: a.contains_key("tcp"),
            force_new: a.contains_key("force-new"),
            auth,
        })
    }

    /// The agent endpoint with the same query the CLI sends.
    pub fn agent_url(&self) -> url::Url {
        let mut url = self.server_url.clone();
        let _ = url.set_scheme(if self.tls { "wss" } else { "ws" });
        url.set_path("/ws/agent");
        url.set_query(None);
        {
            let mut q = url.query_pairs_mut();
            q.append_pair("domain", &self.domain);
            q.append_pair("serviceType", "port");
            q.append_pair("protocol", if self.tcp { "tcp" } else { "http" });
            q.append_pair("caps", "stream,b64body");
            if let Some(org) = &self.organization_id {
                q.append_pair("organizationId", org);
            }
            if self.force_new {
                q.append_pair("forceNew", "true");
            }
            if self.group {
                q.append_pair("groupMode", "true");
                if let Some(id) = &self.instance_id {
                    q.append_pair("instanceId", id);
                }
            }
            if let Some(mode) = &self.ip_mode {
                q.append_pair("ipSecurityMode", mode);
                if !self.allowed_ips.is_empty() {
                    q.append_pair("allowedIps", &self.allowed_ips.join(","));
                }
                if !self.blocked_ips.is_empty() {
                    q.append_pair("blockedIps", &self.blocked_ips.join(","));
                }
            }
            q.append_pair("localPort", &self.local_port.to_string());
            q.append_pair("localHost", &self.local_host);
        }
        url
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn worker_http_args() {
        let c = TunnelConfig::from_args(&args(&[
            "--server", "https://public.koompi.cloud", "--edge", "159.223.71.81", "--port", "3000",
            "--domain", "shop", "--group", "--instance-id", "svc1-0@worker-a", "--host", "172.18.0.5",
            "--org", "org1", "--allow-ip", "203.0.113.1,203.0.113.2", "--auth", "k",
        ]))
        .unwrap();
        assert_eq!(c.server_host, "public.koompi.cloud");
        assert_eq!(c.server_port, 443);
        assert_eq!(c.edge.as_deref(), Some("159.223.71.81"));
        assert!(c.group && !c.tcp);
        let url = c.agent_url().to_string();
        assert!(url.starts_with("wss://public.koompi.cloud/ws/agent?domain=shop&serviceType=port&protocol=http&caps=stream%2Cb64body&organizationId=org1&groupMode=true&instanceId=svc1-0%40worker-a&ipSecurityMode=allowlist&allowedIps=203.0.113.1%2C203.0.113.2&localPort=3000&localHost=172.18.0.5"), "{url}");
    }

    #[test]
    fn worker_tcp_args() {
        let c = TunnelConfig::from_args(&args(&["--server", "https://x.example", "--port", "5432", "--tcp", "--instance-id", "i", "--domain", "i", "--auth", "k"])).unwrap();
        assert!(c.tcp && !c.group);
        assert!(c.agent_url().as_str().contains("protocol=tcp"));
    }

    #[test]
    fn block_ip_replaces_allow_ip_as_in_the_cli() {
        let c = TunnelConfig::from_args(&args(&["--port", "1", "--domain", "d", "--auth", "k", "--allow-ip", "1.1.1.1", "--block-ip", "2.2.2.2"])).unwrap();
        let url = c.agent_url().to_string();
        assert!(url.contains("ipSecurityMode=blocklist&blockedIps=2.2.2.2"), "{url}");
        assert!(!url.contains("allowedIps"));
    }

    #[test]
    fn required_options() {
        assert!(TunnelConfig::from_args(&args(&["--domain", "x", "--auth", "k"])).is_err());
        assert!(TunnelConfig::from_args(&args(&["--port", "1", "--auth", "k"])).is_err());
    }
}
