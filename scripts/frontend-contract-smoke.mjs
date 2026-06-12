import { readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const nodesPage = await readFile(path.join(root, "frontend", "src", "pages", "NodesPage.tsx"), "utf8");
const nodeDetailPage = await readFile(path.join(root, "frontend", "src", "pages", "NodeDetailPage.tsx"), "utf8");
const settingsPage = await readFile(path.join(root, "frontend", "src", "pages", "SettingsPage.tsx"), "utf8");
const wizardPage = await readFile(path.join(root, "frontend", "src", "pages", "NodeWizardPage.tsx"), "utf8");
const styles = await readFile(path.join(root, "frontend", "src", "styles.css"), "utf8");

assertIncludes("NodesPage subscription field errors", nodesPage, [
  "import { ApiError, api } from \"../api\"",
  "subscriptionFieldErrors",
  "fieldErrorsFromApi(error)",
  "normalizeSubscriptionField",
  "className={subscriptionFieldErrors.name ? \"field-error\" : undefined}",
  "className={subscriptionFieldErrors.url ? \"field-error\" : undefined}",
  "className={subscriptionFieldErrors.content ? \"field-error\" : undefined}",
  "className={subscriptionFieldErrors.refreshCron ? \"field-error\" : undefined}",
  "<span className=\"field-error-text\">{subscriptionFieldErrors.name}</span>",
  "<span className=\"field-error-text\">{subscriptionFieldErrors.url}</span>",
  "<span className=\"field-error-text\">{subscriptionFieldErrors.content}</span>",
  "<span className=\"field-error-text\">{subscriptionFieldErrors.refreshCron}</span>"
]);

assertIncludes("NodesPage delete confirmation", nodesPage, [
  "pendingDeleteNode",
  "openDeleteNode(node)",
  "confirmDeleteNode",
  "deleteText !== \"DELETE\"",
  "placeholder=\"DELETE\"",
  "删除后只移除节点配置",
  "api.deleteNode(direction, pendingDeleteNode.id)"
]);

assertIncludes("NodesPage subscription delete confirmation", nodesPage, [
  "pendingDeleteSubscription",
  "openDeleteSubscription(subscription)",
  "confirmDeleteSubscription",
  "subscriptionDeleteText !== \"DELETE\"",
  "api.deleteSubscription(pendingDeleteSubscription.id)",
  "Promise.all([loadSubscriptions(), load()])",
  "确认删除订阅源",
  "系统会解除来源关联并标记为订阅缺失"
]);

if (nodesPage.includes("onClick={() => remove(node.id)}")) {
  throw new Error("NodesPage table delete button bypasses DELETE confirmation");
}

if (nodesPage.includes("window.confirm")) {
  throw new Error("NodesPage uses window.confirm instead of an explicit confirmation panel");
}

assertIncludes("NodeDetail local stop confirmation", nodeDetailPage, [
  "openStopConfirm()",
  "direction === \"local\" && node.enabled",
  "confirmStop",
  "stopText !== \"STOP\"",
  "placeholder=\"STOP\"",
  "api.stopLocalNode(id)",
  "接入客户端"
]);

if (!/if \(direction === "local" && node\.enabled\) \{\s*openStopConfirm\(\);\s*return;\s*\}/s.test(nodeDetailPage)) {
  throw new Error("NodeDetail local enabled toggle does not require STOP confirmation");
}

assertIncludes("SettingsPage private subscription security toggle", settingsPage, [
  "toggleAllowPrivateSubscriptions",
  "allowPrivateSubscriptions",
  "api.updateSystemSettings({",
  "订阅安全边界",
  "允许订阅源访问内网地址"
]);

assertIncludes("SettingsPage restore and restart confirmation", settingsPage, [
  "pendingRestoreBackup",
  "openRestoreBackup(backup)",
  "confirmRestoreBackup",
  "restoreConfirmText !== \"RESTORE\"",
  "api.restoreBackup(pendingRestoreBackup.file)",
  "确认恢复备份",
  "placeholder=\"RESTORE\"",
  "restartConfirmOpen",
  "openRestartConfirm",
  "confirmRestartSystem",
  "restartConfirmText !== \"RESTART\"",
  "api.restartSystem()",
  "确认重启代理核心",
  "placeholder=\"RESTART\""
]);

if (settingsPage.includes("window.confirm")) {
  throw new Error("SettingsPage uses window.confirm instead of explicit confirmation panels");
}

assertIncludes("NodeWizard field errors", wizardPage, [
  "fieldErrors",
  "normalizeField",
  "field-error-text"
]);

assertIncludes("NodeWizard protocol credential state", wizardPage, [
  "credentialEdited",
  "function chooseProtocol(nextProtocol: string)",
  "nextProtocol !== \"smart\" && !credentialEdited",
  "setCredential(generateCredential(nextProtocol))",
  "onClick={() => chooseProtocol(value)}",
  "nextProtocol === \"trojan\" || nextProtocol === \"hysteria2\"",
  "nextProtocol === \"wireguard\""
]);

if (wizardPage.includes("onClick={() => setProtocol(value)}")) {
  throw new Error("NodeWizard protocol buttons bypass credential-preserving chooseProtocol");
}

assertIncludes("field error styles", styles, [
  "input.field-error",
  "textarea.field-error",
  ".field-error-text"
]);

console.log("frontend contract smoke ok");

function assertIncludes(name, content, needles) {
  for (const needle of needles) {
    if (!content.includes(needle)) {
      throw new Error(`${name} missing ${needle}`);
    }
  }
}
