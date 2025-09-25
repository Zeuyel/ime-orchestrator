# 发布指南（Obsidian 社区插件）

本文依据 Obsidian 官方模板（master 分支）整理了发布流程，适用于本插件 ime-orchestrator。

## 一、版本与兼容
- 修改 `manifest.json`：更新 `version`（例如 0.1.1）和 `minAppVersion`（例如 0.15.0）。
- 维护 `versions.json`：新增一条映射 `"<插件版本>": "<最低 Obsidian 版本>"`。
  - 旧版 Obsidian 会按该表下载兼容版本。

## 二、构建产物
- 运行构建：`npm run build`（生成 `main.js`）。
- 需要打包到 Release 的文件：
  - `manifest.json`
  - `main.js`
  - `styles.css`（若有样式则包含，没有可省略）

## 三、创建 GitHub Release
- Tag 名：使用“纯版本号”，不要加 `v` 前缀（如 `0.1.1`）。
- 附件：将上面的产物文件作为二进制附件上传；注意 `manifest.json` 既在仓库根目录，也要作为附件上传。
- 说明：可在 Release 描述中写明变更日志与最低兼容版本。

## 四、加入社区插件列表
- 参阅官方指引（Plugin guidelines）。
- 先发布一个稳定 Release。
- 确保仓库有完善的 `README.md` 与 `manifest.json`。
- 前往 `obsidianmd/obsidian-releases` 仓库提交 PR，按其模板填写信息与下载地址。

## 五、版本号快捷命令（可选）
- 建议使用 `npm version patch|minor|major` 辅助版本号管理；但仍需手动确认 `manifest.json` 的 `minAppVersion` 与更新 `versions.json`。

## 六、本仓库现状
- 当前版本：见 `manifest.json` 与 `package.json`。
- 兼容矩阵：见 `versions.json`。

> 参考：Obsidian 官方 sample plugin 的发布步骤与文件布局。
