# RC2 Windows 安装验收包

本包固定验证 `Detachym-1.1.0-rc.2-x64.exe`。安装包与已通过真实本地 FastAPI 链路验收的候选一致。**准备好验收包不代表安装验收已经通过。**

## 使用

在已启用 Windows Sandbox 的测试机上，将压缩包解压到一个单独目录，进入该目录执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Start-SandboxAcceptance.ps1
```

脚本校验安装包后打开一个全新的 Sandbox，自动执行静默安装、文件及快捷方式校验、进程启动、卸载和重装。安装后的 `app.asar` 必须与候选清单的 SHA-256 完全一致。

结果保存在解压目录的 `results/installation-result.json`。失败时查看 `error`；没有这个文件或只有配置文件时，不能记录为通过。进程启动检查只验证程序没有立即退出，不代表三个窗口和全部交互已经验证。

安装脚本只允许在 Sandbox 默认账号 `WDAGUtilityAccount` 下执行，拒绝直接在日常用户环境安装或卸载。没有 Sandbox 的独立测试机可以人工安装候选包并填写下面的记录。

配置关闭网络和剪贴板，仅映射本验收包为只读，单独映射 `results` 为可写。不会映射项目、个人文件或账号凭据。配置方式参考 [Microsoft Windows Sandbox 文档](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-configure-using-wsb-file)。

只检查安装包、生成配置而不启动 Sandbox：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Run-InstallAcceptance.ps1 -ValidateOnly
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Start-SandboxAcceptance.ps1 -GenerateOnly
```

## 仍需人工完成的验收

| 项目 | 操作和通过条件 | 实测时间、结果、证据 |
|---|---|---|
| 窗口与安装 | 干净安装后，主面板、桌宠、快捷聊天正常；卸载和重装正常 | 待填写 |
| 公网闭环 | 使用授权测试邮箱和测试账号，连接明确版本的公网后端；创建提醒、自然等待、手动完成，数据库与桌面一致 | 待填写 |
| 睡眠唤醒 | 在独立 Windows 设备设置将到期提醒，进入睡眠，唤醒后正常恢复且不重复送达 | 待填写 |
| 跨日 | 使用实际时钟跨过北京时间零点，验证归属日期、每日状态和提醒连续性 | 待填写 |
| 两个桌面 | 同一测试账号在两个独立桌面领取同一里程碑，后端只产生一次有效领取，播放和 ACK 可恢复 | 待填写 |

本包关闭网络的自动流程不覆盖公网链路；Sandbox 中的安装结果也不能代替真实设备睡眠及跨日验证。不要在日常工作机器上自动执行休眠、卸载或清理个人数据。
