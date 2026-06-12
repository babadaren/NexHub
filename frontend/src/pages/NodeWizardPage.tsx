import { FormEvent, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { CheckCircle, ClipboardPaste, Eye, Save, TestTube2 } from "lucide-react";
import { ApiError, api } from "../api";
import type { Direction, NodeConfig, NodeTestResult, ParsedImportNode } from "../types";
import { StatusBadge } from "../components/Status";

const remoteProtocols = [
  ["smart", "智能识别", "推荐"],
  ["vless", "VLESS", "常用"],
  ["trojan", "Trojan", "TLS"],
  ["shadowsocks", "Shadowsocks", "轻量"],
  ["socks5", "SOCKS5", "通用"],
  ["wireguard", "WireGuard", "组网"],
  ["hysteria2", "Hysteria2", "UDP"],
  ["http", "HTTP", "简单"]
];

const localProtocols = [
  ["http", "HTTP", "局域网"],
  ["socks5", "SOCKS5", "通用"],
  ["shadowsocks", "Shadowsocks", "设备共享"],
  ["vless", "VLESS", "公网"],
  ["trojan", "Trojan", "TLS"],
  ["wireguard", "WireGuard", "组网"],
  ["hysteria2", "Hysteria2", "UDP"]
];

const localUseOptions = [
  {
    key: "local",
    label: "仅本机软件用",
    hint: "HTTP / 127.0.0.1 / 20000",
    protocol: "http",
    listenHost: "127.0.0.1",
    port: "20000",
    exposure: "local"
  },
  {
    key: "lan",
    label: "给局域网设备用",
    hint: "Shadowsocks / 0.0.0.0 / 20001",
    protocol: "shadowsocks",
    listenHost: "0.0.0.0",
    port: "20001",
    exposure: "lan"
  },
  {
    key: "public",
    label: "给外地设备连接",
    hint: "VLESS / 0.0.0.0 / 443",
    protocol: "vless",
    listenHost: "0.0.0.0",
    port: "443",
    exposure: "public"
  },
  {
    key: "relay",
    label: "作为中继入口",
    hint: "Trojan / 0.0.0.0 / 20002",
    protocol: "trojan",
    listenHost: "0.0.0.0",
    port: "20002",
    exposure: "relay"
  }
] as const;

export function NodeWizardPage({ direction }: { direction: Direction }) {
  const navigate = useNavigate();
  const [protocol, setProtocol] = useState(direction === "remote" ? "smart" : "http");
  const [localUse, setLocalUse] = useState<(typeof localUseOptions)[number]["key"]>("lan");
  const [name, setName] = useState(direction === "remote" ? "" : "Home-Proxy");
  const [server, setServer] = useState("");
  const [port, setPort] = useState(direction === "remote" ? "443" : "20001");
  const [exposure, setExposure] = useState("lan");
  const [credential, setCredential] = useState("");
  const [credentialEdited, setCredentialEdited] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [parsedNodes, setParsedNodes] = useState<ParsedImportNode[]>([]);
  const [message, setMessage] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [testResult, setTestResult] = useState<NodeTestResult | undefined>();
  const [createdNode, setCreatedNode] = useState<NodeConfig | undefined>();

  useEffect(() => {
    setProtocol(direction === "remote" ? "smart" : "http");
    setParsedNodes([]);
    setMessage("");
    setFieldErrors({});
    setCreatedNode(undefined);
    setCredentialEdited(false);
    if (direction === "local") applyLocalUse("lan", true);
  }, [direction]);

  function applyLocalUse(key: (typeof localUseOptions)[number]["key"], resetCredential = false) {
    const option = localUseOptions.find((item) => item.key === key) ?? localUseOptions[1];
    setLocalUse(option.key);
    setProtocol(option.protocol);
    setServer(option.listenHost);
    setPort(option.port);
    setExposure(option.exposure);
    if (resetCredential || !credentialEdited) setCredential(generateCredential(option.protocol));
    const presetNames = localUseOptions.map((item) => item.label.replace("用", ""));
    if (!name || name === "Home-Proxy" || presetNames.includes(name)) setName(option.label.replace("用", ""));
  }

  function generateCredential(nextProtocol = protocol) {
    if (nextProtocol === "vless") return "11111111-1111-4111-8111-111111111111";
    if (nextProtocol === "trojan") return "change-me-strong-password";
    if (nextProtocol === "shadowsocks") return "change-me-ss-password";
    return "change-me";
  }

  async function parseSmartImport() {
    setMessage("");
    clearFieldError("input");
    try {
      const result = await api.parseImport(importText);
      setParsedNodes(result.nodes);
      const parsed = result.nodes.filter((node) => node.status === "parsed").length;
      const failed = result.nodes.length - parsed;
      setMessage(parsed > 0 ? `已识别 ${parsed} 个节点${failed ? `，${failed} 个失败` : ""}` : "没有识别到可导入节点");
    } catch (error) {
      showError(error, "解析失败");
    }
  }

  async function applySmartImport() {
    const nodes = parsedNodes.filter((node) => node.status === "parsed");
    if (nodes.length === 0) {
      setMessage("没有可保存的解析结果");
      return;
    }
    setFieldErrors({});
    try {
      const result = await api.applyImport(nodes);
      setMessage(result.message);
      setCreatedNode(result.nodes[0]);
    } catch (error) {
      showError(error, "保存识别结果失败");
    }
  }

  function buildPayload() {
    return {
      name: name || (direction === "remote" ? `${protocol.toUpperCase()} 节点` : "本地节点"),
      protocol: protocol === "smart" ? "vless" : protocol,
      config:
        direction === "remote"
          ? { server: server || "example.com", port: Number(port), credential, importText }
          : buildLocalConfig(protocol, server, port, exposure, credential)
    };
  }

  async function saveDraft(event?: FormEvent) {
    event?.preventDefault();
    setFieldErrors({});
    try {
      const node = createdNode ?? (await api.createNode(direction, buildPayload()));
      setCreatedNode(node);
      setMessage("节点已保存为草稿，测试通过后才会启用。");
      return node.id;
    } catch (error) {
      showError(error, "保存草稿失败");
      return undefined;
    }
  }

  async function submit(event: FormEvent) {
    const id = await saveDraft(event);
    if (!id) return;
    navigate(`/${direction}-nodes/${id}`);
  }

  async function saveAndTest() {
    setFieldErrors({});
    try {
      if (createdNode) {
        const result = await api.testNode(direction, createdNode.id);
        const latest = await api.node(direction, createdNode.id);
        setCreatedNode(latest);
        setTestResult(result);
        setMessage(result.humanMessage);
        return;
      }
      const result = await api.testCreateNode(direction, buildPayload());
      setCreatedNode(result.node);
      if (result.test) {
        setTestResult(result.test);
        setMessage(result.test.humanMessage);
      } else {
        setMessage("节点已保存为草稿，未执行测试。");
      }
    } catch (error) {
      showError(error, "一键测试失败");
    }
  }

  function showError(error: unknown, fallback: string) {
    setMessage(error instanceof Error ? error.message : fallback);
    if (error instanceof ApiError) {
      const next: Record<string, string> = {};
      for (const field of error.fields.length ? error.fields : error.field ? [error.field] : []) {
        next[normalizeField(field)] = error.suggestion ?? error.message;
      }
      setFieldErrors(next);
    }
  }

  function clearFieldError(field: string) {
    setFieldErrors((current) => {
      const next = { ...current };
      delete next[field];
      return next;
    });
  }

  const protocols = direction === "remote" ? remoteProtocols : localProtocols;
  const smartMode = direction === "remote" && protocol === "smart";

  return (
    <div className="page wizard-page">
      <div className="wizard-steps">
        <span className="active">1 选择类型</span>
        <span>2 填写信息</span>
        <span>3 一键测试</span>
        <span>4 保存</span>
      </div>

      <section className="wizard-grid">
        <div className="panel">
          <h2>{direction === "remote" ? "选择节点类型" : "选择给谁用"}</h2>
          <p>{direction === "remote" ? "不懂协议时，保持智能识别即可" : "系统会根据用途推荐端口和认证方式"}</p>
          {direction === "local" ? (
            <div className="protocol-grid local-use-grid">
              {localUseOptions.map((option) => (
                <button key={option.key} className={localUse === option.key ? "protocol selected" : "protocol"} onClick={() => applyLocalUse(option.key)}>
                  <strong>{option.label}</strong>
                  <span>{option.hint}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="protocol-grid">
              {protocols.map(([value, label, hint]) => (
                <button key={value} className={protocol === value ? "protocol selected" : "protocol"} onClick={() => setProtocol(value)}>
                  <strong>{label}</strong>
                  <span>{hint}</span>
                </button>
              ))}
            </div>
          )}
          {direction === "local" && (
            <button type="button" className="advanced-toggle local-protocol-toggle" onClick={() => setAdvancedOpen((value) => !value)}>
              高级：手动选择协议
            </button>
          )}
          {direction === "local" && advancedOpen && (
            <div className="protocol-grid">
              {protocols.map(([value, label, hint]) => (
                <button key={value} className={protocol === value ? "protocol selected" : "protocol"} onClick={() => setProtocol(value)}>
                  <strong>{label}</strong>
                  <span>{hint}</span>
                </button>
              ))}
            </div>
          )}
          {direction === "remote" && (
            <label className="paste-box">
              <ClipboardPaste size={18} />
              粘贴分享链接或订阅 URL
              <textarea
                className={fieldErrors.input ? "field-error" : undefined}
                value={importText}
                onChange={(event) => {
                  clearFieldError("input");
                  setImportText(event.target.value);
                }}
                placeholder="vmess:// / vless:// / Clash YAML / Sing-box JSON"
              />
              {fieldErrors.input && <span className="field-error-text">{fieldErrors.input}</span>}
            </label>
          )}
        </div>

        {smartMode ? (
          <section className="panel form-panel">
            <h2>智能识别预览</h2>
            <p>先解析链接或配置片段，确认后再保存为远端节点。</p>
            <div className="form-actions">
              <button type="button" className="primary" onClick={parseSmartImport} disabled={!importText.trim()}>
                <Eye size={18} />
                解析预览
              </button>
              <button type="button" className="success-btn" onClick={applySmartImport} disabled={!parsedNodes.some((node) => node.status === "parsed")}>
                <Save size={18} />
                保存识别结果
              </button>
            </div>
            {parsedNodes.length > 0 && (
              <div className="import-preview-list">
                {parsedNodes.map((node) => (
                  <div key={node.id} className={node.status === "parsed" ? "import-preview-item" : "import-preview-item failed"}>
                    <strong>{node.name}</strong>
                    <span>{node.protocol.toUpperCase()}</span>
                    <span>{node.status === "parsed" ? `${node.server ?? "-"}:${node.port ?? "-"}` : node.error}</span>
                  </div>
                ))}
              </div>
            )}
            {createdNode && (
              <div className="saved-next-actions">
                <CheckCircle size={22} />
                <strong>保存成功</strong>
                <Link className="primary small" to={`/remote-nodes/${createdNode.id}`}>查看详情</Link>
                <Link className="ghost small" to="/remote-nodes/new">继续创建</Link>
              </div>
            )}
          </section>
        ) : (
          <form className="panel form-panel" onSubmit={submit}>
            <h2>{direction === "remote" ? "填写连接信息" : "填写本地节点信息"}</h2>
            <p>只显示当前协议必要字段</p>
            <label>
              节点名称
              <input
                className={fieldErrors.name ? "field-error" : undefined}
                value={name}
                onChange={(event) => {
                  clearFieldError("name");
                  setName(event.target.value);
                }}
                placeholder="例如 HK-01"
              />
              {fieldErrors.name && <span className="field-error-text">{fieldErrors.name}</span>}
            </label>
            <label>
              {direction === "remote" ? "服务器地址" : "监听地址"}
              <input
                className={fieldErrors.server ? "field-error" : undefined}
                value={server}
                onChange={(event) => {
                  clearFieldError("server");
                  setServer(event.target.value);
                }}
                placeholder={direction === "remote" ? "例如 hk.example.com" : "默认 0.0.0.0"}
              />
              {fieldErrors.server && <span className="field-error-text">{fieldErrors.server}</span>}
            </label>
            <label>
              端口
              <input
                className={fieldErrors.port ? "field-error" : undefined}
                value={port}
                onChange={(event) => {
                  clearFieldError("port");
                  setPort(event.target.value);
                }}
                placeholder="443"
              />
              {fieldErrors.port && <span className="field-error-text">{fieldErrors.port}</span>}
            </label>
            <label>
              {direction === "remote" ? "UUID / 密码" : "访问密码 / UUID"}
              <input
                type="password"
                className={fieldErrors.credential ? "field-error" : undefined}
                value={credential}
                onChange={(event) => {
                  clearFieldError("credential");
                  setCredentialEdited(true);
                  setCredential(event.target.value);
                }}
                placeholder="自动隐藏，可粘贴"
              />
              {fieldErrors.credential && <span className="field-error-text">{fieldErrors.credential}</span>}
            </label>
            {direction === "remote" && (
              <button type="button" className="advanced-toggle" onClick={() => setAdvancedOpen((value) => !value)}>
                高级参数：Reality / WebSocket Path / gRPC ServiceName / Fingerprint
              </button>
            )}
            {direction === "remote" && advancedOpen && (
              <div className="advanced-fields">
                <label>
                  TLS / SNI
                  <input placeholder="默认自动检测" />
                </label>
                <label>
                  传输方式
                  <select defaultValue="tcp">
                    <option value="tcp">TCP</option>
                    <option value="ws">WebSocket</option>
                    <option value="grpc">gRPC</option>
                  </select>
                </label>
              </div>
            )}
            {direction === "local" && (
              <div className="advanced-fields">
                <label>
                  开放范围
                  <select value={exposure} onChange={(event) => setExposure(event.target.value)}>
                    <option value="local">仅本机</option>
                    <option value="lan">局域网</option>
                    <option value="public">公网</option>
                    <option value="relay">中继</option>
                  </select>
                </label>
                <label>
                  推荐协议
                  <input value={protocol.toUpperCase()} readOnly />
                </label>
              </div>
            )}
            {testResult && (
              <div className="test-result">
                <h3>
                  <CheckCircle size={18} />
                  测试结果 <StatusBadge status={testResult.finalStatus} />
                </h3>
                <p>{testResult.humanMessage}</p>
                {testResult.steps.map((step) => (
                  <div key={step.name}>
                    <span>{step.name}</span>
                    <StatusBadge status={step.status} />
                    <em>{step.message}</em>
                  </div>
                ))}
              </div>
            )}
            {createdNode && (
              <div className="saved-next-actions">
                <CheckCircle size={22} />
                <strong>保存成功</strong>
                <Link className="primary small" to={`/${direction}-nodes/${createdNode.id}`}>查看详情</Link>
                {direction === "local" && <Link className="ghost small" to={`/${direction}-nodes/${createdNode.id}`}>分享二维码</Link>}
                <Link className="ghost small" to={`/${direction}-nodes/new`}>继续创建</Link>
              </div>
            )}
            <div className="form-actions">
              <button type="button" className="primary" onClick={saveAndTest}>
                <TestTube2 size={18} />
                一键测试
              </button>
              <button className="success-btn">
                <Save size={18} />
                保存草稿
              </button>
            </div>
          </form>
        )}
      </section>
      {message && <div className="notice">{message}</div>}
    </div>
  );
}

function buildLocalConfig(protocol: string, listenHost: string, port: string, exposure: string, credential: string) {
  const config: Record<string, unknown> = {
    listenHost: listenHost || "0.0.0.0",
    listenPort: Number(port),
    exposure,
    credential
  };
  if (protocol === "vless") {
    config.uuid = credential || "11111111-1111-4111-8111-111111111111";
    config.tls = exposure === "public" || exposure === "relay";
  }
  if (protocol === "trojan" || protocol === "hysteria2") {
    config.password = credential || "change-me-strong-password";
    config.tls = true;
  }
  if (protocol === "shadowsocks") {
    config.method = "2022-blake3-aes-128-gcm";
    config.password = credential || "change-me-ss-password";
  }
  if (protocol === "wireguard") {
    config.privateKey = credential || "change-me-wireguard-private-key";
    config.address = "10.0.0.1/24";
  }
  return config;
}

function normalizeField(field: string) {
  if (field === "input") return "input";
  if (field.endsWith(".server") || field.endsWith(".host") || field.endsWith(".listenHost")) return "server";
  if (field.endsWith(".port") || field.endsWith(".listenPort")) return "port";
  if (field.endsWith(".credential") || field.endsWith(".uuid") || field.endsWith(".password")) return "credential";
  return field.split(".").at(-1) ?? field;
}
