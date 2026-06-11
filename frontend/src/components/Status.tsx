import type { NodeStatus, TestStatus } from "../types";

export function StatusBadge({ status }: { status?: NodeStatus | TestStatus | string }) {
  const value = status ?? "draft";
  const label: Record<string, string> = {
    enabled: "正常",
    disabled: "停用",
    draft: "草稿",
    error: "错误",
    passed: "通过",
    warning: "警告",
    failed: "失败",
    normal: "正常"
  };
  return <span className={`status ${value}`}>{label[value] ?? value}</span>;
}
