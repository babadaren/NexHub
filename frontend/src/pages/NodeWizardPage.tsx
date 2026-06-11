import { FormEvent, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { CheckCircle, ClipboardPaste, Save, TestTube2 } from "lucide-react";
import { api } from "../api";
import type { Direction, NodeTestResult } from "../types";
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

export function NodeWizardPage({ direction }: { direction: Direction }) {
  const navigate = useNavigate();
  const [protocol, setProtocol] = useState(direction === "remote" ? "smart" : "http");
  const [name, setName] = useState(direction === "remote" ? "" : "Home-Proxy");
  const [server, setServer] = useState("");
  const [port, setPort] = useState(direction === "remote" ? "443" : "20001");
  const [credential, setCredential] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [testResult, setTestResult] = useState<NodeTestResult | undefined>();
  const [createdId, setCreatedId] = useState<string | undefined>();

  useEffect(() => {
    setProtocol(direction === "remote" ? "smart" : "http");
  }, [direction]);

  async function save(event?: FormEvent, runTest = false) {
    event?.preventDefault();
    const payload = {
      name: name || (direction === "remote" ? `${protocol.toUpperCase()} 节点` : "本地节点"),
      protocol: protocol === "smart" ? "vless" : protocol,
      enabled: false,
      config:
        direction === "remote"
          ? { server: server || "example.com", port: Number(port), credential, importText }
          : { listenHost: direction === "local" ? "0.0.0.0" : server, listenPort: Number(port), exposure: "lan", credential }
    };
    const node = createdId ? undefined : await api.createNode(direction, payload);
    const nodeId = createdId ?? node!.id;
    setCreatedId(nodeId);
    if (runTest) {
      const result = await api.testNode(direction, nodeId);
      setTestResult(result);
    }
    return nodeId;
  }

  async function submit(event: FormEvent) {
    const id = await save(event, false);
    navigate(`/${direction}-nodes/${id}`);
  }

  async function saveAndTest() {
    await save(undefined, true);
  }

  const protocols = direction === "remote" ? remoteProtocols : localProtocols;

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
          <h2>{direction === "remote" ? "选择节点类型" : "选择用途或协议"}</h2>
          <p>{direction === "remote" ? "不懂协议时，保持智能识别即可" : "系统会根据用途推荐端口和认证方式"}</p>
          <div className="protocol-grid">
            {protocols.map(([value, label, hint]) => (
              <button key={value} className={protocol === value ? "protocol selected" : "protocol"} onClick={() => setProtocol(value)}>
                <strong>{label}</strong>
                <span>{hint}</span>
              </button>
            ))}
          </div>
          {direction === "remote" && (
            <label className="paste-box">
              <ClipboardPaste size={18} />
              粘贴分享链接或订阅 URL
              <textarea value={importText} onChange={(event) => setImportText(event.target.value)} placeholder="vmess:// / vless:// / Clash YAML / Sing-box JSON" />
            </label>
          )}
        </div>

        <form className="panel form-panel" onSubmit={submit}>
          <h2>{direction === "remote" ? "填写连接信息" : "填写本地节点信息"}</h2>
          <p>只显示当前协议必要字段</p>
          <label>
            节点名称
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如 HK-01" />
          </label>
          <label>
            {direction === "remote" ? "服务器地址" : "监听地址"}
            <input value={server} onChange={(event) => setServer(event.target.value)} placeholder={direction === "remote" ? "例如 hk.example.com" : "默认 0.0.0.0"} />
          </label>
          <label>
            端口
            <input value={port} onChange={(event) => setPort(event.target.value)} placeholder="443" />
          </label>
          <label>
            {direction === "remote" ? "UUID / 密码" : "访问密码 / UUID"}
            <input type="password" value={credential} onChange={(event) => setCredential(event.target.value)} placeholder="自动隐藏，可粘贴" />
          </label>
          <button type="button" className="advanced-toggle" onClick={() => setAdvancedOpen((value) => !value)}>
            高级参数：Reality / WebSocket Path / gRPC ServiceName / Fingerprint
          </button>
          {advancedOpen && (
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
          <div className="form-actions">
            <button type="button" className="primary" onClick={saveAndTest}>
              <TestTube2 size={18} />
              一键测试
            </button>
            <button className="success-btn">
              <Save size={18} />
              保存
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
