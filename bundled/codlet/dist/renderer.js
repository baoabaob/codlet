module.exports = (() => {
    const CAPABILITY_TOKEN = 'codex.ui.titlebar.afterMenu@1';
    const MOUNT_ATTRIBUTE = 'data-codlet-capability';
    const STYLE_ATTRIBUTE = 'data-codlet-style';
    const BUTTON_ATTRIBUTE = 'data-codlet-titlebar-button';
    const PANEL_ATTRIBUTE = 'data-codlet-panel';
    const MOUNT_CAPABILITY = Object.freeze({ name: 'codex.ui.titlebar.afterMenu', api: 1, scope: 'target' });
    const APPEARANCE_CAPABILITY = Object.freeze({ name: 'codex.ui.appearance', api: 1, scope: 'target' });
    const RUNTIME_PING_CAPABILITY = Object.freeze({ name: 'codlet.runtime.ping', api: 1, scope: 'target' });
    const RUNTIME_MANAGE_CAPABILITY = Object.freeze({ name: 'codlet.runtime.manage', api: 1, scope: 'target' });

    /* Lucide x and refresh-cw: https://github.com/lucide-icons/lucide/tree/main/icons
     * ISC License
     * Copyright (c) 2026 Lucide Icons and Contributors
     * Permission to use, copy, modify, and/or distribute this software for any
     * purpose with or without fee is hereby granted, provided that the above
     * copyright notice and this permission notice appear in all copies.
     * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
     * WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
     * MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
     * ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
     * WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
     * ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
     * OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
     *
     * The x icon is derived from Feather, under The MIT License (MIT).
     * Copyright (c) 2013-present Cole Bemis
     * Permission is hereby granted, free of charge, to any person obtaining a copy
     * of this software and associated documentation files (the "Software"), to deal
     * in the Software without restriction, including without limitation the rights
     * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
     * copies of the Software, and to permit persons to whom the Software is
     * furnished to do so, subject to the following conditions:
     * The above copyright notice and this permission notice shall be included in all
     * copies or substantial portions of the Software.
     * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
     * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
     * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
     * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
     * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
     * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
     * SOFTWARE.
     */
    const ICONS = {
        close: ['M18 6 6 18', 'm6 6 12 12'],
        refresh: ['M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8', 'M21 3v5h-5',
            'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16', 'M8 16H3v5']
    };

    let ui, style, button, panel, pluginList, managementStatus, refreshButton, closeButton;
    const ROLE_BY_CLASS = Object.freeze({ 'codlet-panel-header': 'dialogHeader', 'codlet-panel-title': 'heading', 'codlet-panel-body': 'dialogBody', 'codlet-plugin-list': 'section', 'codlet-plugin-actions': 'actions', 'codlet-plugin-name': 'label', 'codlet-plugin-version': 'description', 'codlet-confirmation-actions': 'dialogActions', 'codlet-status': 'status' });
    let panelTitle, versionLabel, developmentLabel, clientStatusLine, settingsSection, searchInput, updateButton, updateSection, updateBody, updateStatus, updateTimer = null, updateReply = null, updateBusy = false;
    let headerUpdateTimer = null, headerUpdateRequest = 0, updateIconName = null;
    let confirmation, confirmationCopy, confirmationStatus, confirmButton, cancelButton, actionOrigin;
    let confirmationSelection = null;
    let visiblePlugins = [];
    let tooltip = null, tooltipControl = null, tooltipTimer = null;
    let observer, keydown, focusin, resize, cancelDocumentWait;
    let mountToken = null;
    let returnFocus = null;
    let outsideFocus = null;
    let panelAnchor = null;
    let lifecycle = 0;
    let panelRequest = 0;
    let action = 'idle';
    let actionError = '';
    let pendingOperation = null;
    let managementBusy = false;
    let operationTimer = null;
    const mutationControls = new Set();
    const renderedPlugins = new Map();
    let page = 'plugins', localManagement = null;
    let importButton, importSection, importPath, localFields, chooseFolderButton, importStatus, importErrorDetails, importErrorText, previewBody, importSubmit;
    let importTrust, importEnable, importPreview = null, importBusy = false, localRequest = 0, pickerTimer = null, previewTimer = null;
    let localTab, githubTab, communityLink, confirmationHeading, removeSourceChoice, removalPreview = null, removalRequest = 0, removalBusy = false;
    let detailsSection, detailsBody, detailsStatus, detailsPlugin = null;
    let githubButton, githubFields, githubUrl, githubRead, githubRelease, githubAsset, githubDownload, githubCancel, githubRetry;
    let importMode = 'local', importOperation = 'install', importTarget = null, githubCatalog = null, githubJob = null, githubTimer = null;
    let runtimeContext = null;
    const COMMUNITY_URL = 'https://github.com/topics/codlet-plugin';
    const importGrants = new Map(), scopeInputs = new Map();
    const PERMISSION_COPY = Object.freeze({
        'ui.dom': 'Read and change the page interface', 'ui.mainWorld': 'Run in the page’s main JavaScript world',
        'cdp.raw': 'Use raw browser debugging access', 'host.process': 'Run native code with your user account’s OS permissions',
        'host.fs': 'Read files inside explicitly allowed folders', 'host.network': 'Request explicitly allowed HTTP(S) origins',
        'host.system': 'Read basic system information', 'runtime.manage': 'Manage other plugins and their permissions'
    });
    const textBindings = new Map(), buttonCaptions = new WeakMap();
    let stopLocale = null;
    const TRANSLATIONS = {
        'Back': '返回', 'Codlet': 'Codlet', 'Close Codlet': '关闭 Codlet', 'Import': '导入', 'Import plugins': '导入插件', 'Search plugins': '搜索插件',
        'Refresh plugins': '刷新插件', 'Check for updates': '检查更新', 'Updates': '更新', 'Local folder': '本地文件夹', 'GitHub release': 'GitHub 发布版本',
        'Plugin folder': '插件文件夹', 'Choose plugin folder': '选择插件文件夹', 'Browse community plugins': '浏览社区插件', 'Details': '详情',
        'Active': '运行中', 'Starting': '启动中', 'Stopping': '正在停止', 'Failed': '失败', 'Exited': '已退出', 'Waiting for renderer': '等待界面加载',
        'Unavailable': '不可用', 'Not active': '未运行', 'Disabled': '已停用', 'Start': '启动', 'Stop': '停止', 'Reload': '重新加载',
        'No plugins': '暂无插件', 'No matching plugins': '没有匹配的插件', 'Loading plugins...': '正在加载插件…', 'Updating plugins...': '正在刷新插件…',
        'Enable Codlet GUI': '启用 Codlet 界面', 'Requested permissions': '请求的权限', 'Granted permissions': '已授权限',
        'Remove': '移除', 'Remove plugin': '移除插件', 'Cancel': '取消', 'Disable': '停用', 'Revoke': '撤销授权', 'Disabling...': '正在停用…',
        'Import local plugin': '导入本地插件', 'Import from GitHub': '从 GitHub 导入', 'Update GitHub plugin': '更新 GitHub 插件', 'Roll back plugin': '回退插件版本',
        'Import plugin': '导入插件', 'Update plugin': '更新插件', 'Confirm local import': '确认导入本地插件', 'Confirm GitHub import': '确认从 GitHub 导入',
        'Confirm managed update': '确认更新托管插件', 'Confirm managed rollback': '确认回退托管插件', 'Trust this local plugin': '信任这个本地插件',
        'Trust this GitHub source': '信任这个 GitHub 来源', 'Enable after import': '导入后启用', 'Enable immediately after importing': '导入完成后立即启用',
        'I trust this plugin’s author and this local folder.': '我信任这个插件的作者和本地文件夹。', 'Loading permissions...': '正在读取权限…',
        'Open plugin folder': '打开插件文件夹', 'Delete source files': '同时删除源文件', 'Delete the plugin source folder': '同时删除插件源文件夹',
        'Checking source folder...': '正在检查源文件夹…', 'Plugin details': '插件详情', 'Local development folder': '本地开发文件夹', 'Codlet managed GitHub package': 'Codlet 托管的 GitHub 插件包', 'Bundled plugin': '内置插件',
        'Read releases': '读取发布版本', 'Read GitHub releases': '读取 GitHub 发布版本', 'GitHub repository or release URL': 'GitHub 仓库或发布链接',
        'GitHub ZIP asset': 'GitHub ZIP 资源包', 'Choose a release': '选择发布版本', 'Choose a ZIP asset': '选择 ZIP 资源包', 'Download and inspect ZIP': '下载并检查 ZIP',
        'Download selected GitHub asset': '下载所选 GitHub 资源包', 'Cancel GitHub task': '取消 GitHub 任务', 'Check task status': '查看任务状态', 'Check GitHub task status': '查看 GitHub 任务状态',
        'Check GitHub versions': '检查 GitHub 版本', 'Installed version history': '已安装版本历史', 'Review rollback': '预览回退', 'Load more versions': '加载更多版本',
        'Loading retained versions...': '正在读取保留的版本…', 'Loading more retained versions...': '正在读取更多版本…', 'No retained versions.': '暂无保留的版本。',
        'Check for Codlet updates': '检查 Codlet 更新', 'Download update': '下载更新', 'Install and restart': '安装并重启', 'Development version': '开发版本',
        'Install and restart Codlet?': '安装并重启 Codlet？', 'The current client will restart and running local tasks will be interrupted.': '当前客户端将重启，正在运行的本地任务会被中断。',
        'Development': '开发版', 'This development build has no configured update source.': '当前为开发版本，尚未配置更新源。', 'Checking for updates...': '正在检查更新…', 'Downloading update...': '正在下载更新…', 'Codlet is up to date.': 'Codlet 已是最新版本。',
        'Installation was requested. Follow the update process to restart Codlet.': '已请求安装，请按更新流程重启 Codlet。', 'Update status is unavailable.': '暂时无法获取更新状态。',
        'Official client update available. A routine update usually does not affect Codlet, but not every plugin is guaranteed to work.': '官方客户端可更新，简单更新通常不会影响Codlet使用，但不保证所有插件均可正常使用。',
        'This Codlet version is not matched to the latest client version. This usually does not affect use, but not every plugin is guaranteed to work.': '当前Codlet未匹配客户端最新版本，这通常不影响使用，但不保证所有插件均可正常使用。',
        'This Codlet version matches the latest client version.': '当前Codlet版本匹配最新客户端版本。',
        'Details for {name}': '{name} 的详情', 'Enable {name}': '启用 {name}', 'Reload {name}': '重新加载 {name}', 'Start {name}': '启动 {name}', 'Stop {name}': '停止 {name}',
        'Remove {name}': '移除 {name}', 'Grant {permission}': '授予 {permission}', 'Revoke {permission}': '撤销 {permission}', 'Review rollback {version}': '预览回退 {version}',
        'Read and change the page interface': '读取和修改页面界面', 'Run in the page’s main JavaScript world': '在页面主 JavaScript 环境中运行', 'Use raw browser debugging access': '使用底层浏览器调试接口',
        'Run native code with your user account’s OS permissions': '以当前用户的系统权限运行原生代码', 'Read files inside explicitly allowed folders': '读取明确允许的文件夹中的文件',
        'Request explicitly allowed HTTP(S) origins': '访问明确允许的 HTTP(S) 来源', 'Read basic system information': '读取基本系统信息', 'Manage other plugins and their permissions': '管理其他插件及其权限'
    };
    Object.assign(TRANSLATIONS, {
        'Plugin list timed out. Refresh to try again.': '插件列表请求超时，请刷新重试。', 'Plugin list unavailable': '无法获取插件列表', 'Plugin list contains duplicate IDs': '插件列表包含重复的 ID',
        'Registration removed; still loaded': '已取消注册，仍在运行', 'Registered, not loaded': '已注册，尚未加载', 'Plugin validation failed': '插件校验失败', 'Host process failed': 'Host 进程失败',
        'Disable {name}?': '停用 {name}？', 'Remove {name}?': '移除 {name}？', 'Revoke permission for {name}?': '撤销 {name} 的权限？', '{name} disabled': '{name} 已停用', 'Codlet is disabled.': 'Codlet 已停用。',
        'This will also disable: {names}.': '同时停用：{names}。', 'Also disable: {names}.': '同时停用：{names}。', 'Dependents: {names}.': '依赖此插件：{names}。',
        'The Codlet GUI will close in all open windows. Re-enable the plugins from the launcher to restore it.': '所有窗口中的 Codlet 界面都会关闭。可通过启动器重新启用插件来恢复。',
        'These plugins will stay disabled until you enable them again.': '这些插件将保持停用，直到你重新启用。',
        'Action status unavailable. Refresh to check again.': '暂时无法获取操作状态，请刷新查询。',
        'Action status is no longer available. The action has not been repeated.': '无法再获取这次操作的状态。操作没有被重复提交。',
        'The action was not confirmed. Refresh checks the same action without repeating it.': '操作结果尚未确认。刷新只查询原操作，不会重复提交。',
        'The action could not be prepared.': '无法准备这次操作。', 'The action was not submitted. Try again when the runtime is ready.': '操作没有提交，请在运行时就绪后重试。',
        'The action finished with an error. Refresh for the current state.': '操作结束时出错，请刷新查看当前状态。', 'Disable was not confirmed': '停用结果尚未确认',
        '{name}: preparing...': '{name}：正在准备…', '{name}: waiting...': '{name}：正在等待…', '{name}: updating...': '{name}：正在更新…',
        '{name}: enabled.': '{name}：已启用。', '{name}: disabled.': '{name}：已停用。', '{name}: reloaded.': '{name}：已重新加载。',
        '{name}: imported and enabled.': '{name}：已导入并启用。', '{name}: imported, disabled.': '{name}：已导入，保持停用。',
        '{name}: updated and enabled.': '{name}：已更新并启用。', '{name}: updated, disabled.': '{name}：已更新，保持停用。',
        '{name}: rolled back and enabled.': '{name}：已回退并启用。', '{name}: rolled back, disabled.': '{name}：已回退，保持停用。',
        '{name}: removed; files kept.': '{name}：已移除，文件保留。', '{name}: removed.': '{name}：已移除。', '{name}: permission revoked.': '{name}：权限已撤销。',
        'Enter the full path to a plugin folder.': '请输入插件文件夹的完整路径。', 'Checking the selected folder...': '正在检查所选文件夹…',
        'Checking the manifest and JavaScript entries...': '正在检查清单和 JavaScript 入口…', 'The import preview is incomplete.': '导入预览信息不完整。',
        'Plugin recognized. Choose permissions to import.': '已识别插件，选择权限后即可导入。', 'Choose a plugin folder in the Windows dialog.': '请在 Windows 对话框中选择插件文件夹。',
        'Folder selection cancelled.': '已取消选择文件夹。', 'Folder selection failed. Enter the full path instead.': '选择文件夹失败，请输入完整路径。',
        'Dependencies': '依赖', 'Dependencies: none': '依赖：无', 'Availability is checked again when enabling.': '启用时会再次检查依赖是否可用。',
        'Renderer: {entry} ({world})': '界面入口：{entry}（{world}）', 'Host: {entry}': 'Host 入口：{entry}',
        'Renderer dependency: {capability}': '界面依赖：{capability}', 'Host dependency: {capability}': 'Host 依赖：{capability}',
        'Currently unavailable: {capabilities}. You can import the folder while disabled, then enable its providers first.': '当前不可用：{capabilities}。可以先导入并保持停用，再启用提供这些依赖的插件。',
        'The plugin runs from this development folder. Removing it keeps these files.': '插件从此开发文件夹运行。移除时默认保留文件。',
        'Automatic reload: on while the plugin is enabled.': '自动重载：插件启用时开启。', 'Automatic reload: off in this session; use Reload after editing.': '自动重载：此会话中关闭，修改后请重新加载。',
        'Already registered at this folder. Confirm all grants again to replace its permission settings.': '此文件夹已注册。重新确认全部授权后会替换现有权限设置。',
        'Current grants: {permissions}. Stop the package before importing it again.': '当前授权：{permissions}。重新导入前请先停用插件。',
        'No permissions requested.': '未请求权限。', 'Allowed read folders': '允许读取的文件夹', 'Allowed network origins': '允许访问的网络来源', 'Allowed child programs': '允许启动的子程序',
        'Allowed read folders — one full path per line': '允许读取的文件夹，每行一个完整路径', 'Allowed network origins — one HTTP(S) origin per line': '允许访问的网络来源，每行一个 HTTP(S) 来源',
        'Allowed child programs — one full .exe path per line': '允许启动的子程序，每行一个完整的 .exe 路径',
        'Empty lists grant no access through the file, network or child-process broker. Native Host code still runs with your OS user permissions.': '列表留空时，文件、网络和子进程代理不授予访问权限。原生 Host 代码仍以当前用户的系统权限运行。',
        '{permission} — {description}': '{permission} — {description}', 'None': '无', 'unknown': '未知', 'unknown (not declared)': '未知（未声明）', 'enabled': '已启用', 'disabled': '已停用',
        'install': '安装', 'update': '更新', 'rollback': '回退', 'matched': '已匹配', 'not available for verification': '无可用摘要进行核验',
        'author declared API {api}': '作者声明 API {api}', 'author declared {platforms}': '作者声明 {platforms}',
        'Runtime compatibility: {compatibility}': '运行时兼容性：{compatibility}', 'Platforms: {platforms}': '平台：{platforms}', 'Author: {author}': '作者：{author}',
        'Codex builds tested: unknown; no verification claim is made by this importer.': '已测试的 Codex 构建：未知；导入器不作兼容性验证承诺。',
        'Repository: {repository}': '仓库：{repository}', 'Release/tag: {tag}': '发布版本／标签：{tag}', 'Asset: {asset}': '资源包：{asset}', 'GitHub digest: {status}': 'GitHub 摘要：{status}',
        'Version: {before} → {after}': '版本：{before} → {after}', 'Release: {before} → {after}': '发布版本：{before} → {after}',
        'Runtime declaration: {before} → {after}': '运行时声明：{before} → {after}', 'Platform declaration: {before} → {after}': '平台声明：{before} → {after}',
        'Permissions added: {permissions}': '新增权限：{permissions}', 'Permissions removed: {permissions}': '减少权限：{permissions}', 'Dependencies added: {capabilities}': '新增依赖：{capabilities}', 'Dependencies removed: {capabilities}': '减少依赖：{capabilities}',
        'Codlet owns this installed package directory. Removing registration keeps the package and plugin data. The SHA-256 identifies downloaded bytes; it does not establish trust in the author.': '此插件包由 Codlet 管理。移除注册时默认保留包文件和插件数据。SHA-256 用于识别下载内容，不能代替对作者的信任。',
        'Currently {state}. This {operation} leaves the plugin disabled unless you select “Enable after import”. Confirm the source and every grant again.': '当前{state}。本次{operation}后默认保持停用，只有勾选“导入后启用”才会启用。请重新确认来源和每项权限。',
        'Enable after {operation}; otherwise keep disabled': '{operation}后启用，否则保持停用',
        'I trust the author and this exact source: {repository}, release {tag}, asset {asset}.': '我信任作者及此确切来源：{repository}，发布版本 {tag}，资源包 {asset}。',
        'Check releases, then explicitly choose a version and asset. Updating requires fresh source trust and grants.': '请检查发布版本并明确选择版本和资源包。更新需要重新信任来源并授权。',
        'Enter a GitHub repository, release or release asset URL. Select a published ZIP package; repository source archives are not installable packages.': '请输入 GitHub 仓库、发布版本或资源包链接，选择已构建的 ZIP 发布包。仓库源码压缩包不能直接安装。',
        'Read releases for this source before downloading. Trust and grants have been cleared.': '下载前请读取此来源的发布版本。之前的信任和授权选择已清除。',
        'The managed package preview is incomplete or does not match the selected plugin and release asset.': '托管包预览不完整，或与所选插件和发布资源包不匹配。',
        'Review the exact source, compatibility, dependencies and permissions before confirming.': '确认前请检查确切来源、兼容性、依赖和权限。',
        'The GitHub release list is incomplete.': 'GitHub 发布版本列表不完整。', 'Choose the exact release and ZIP asset.': '请选择确切的发布版本和 ZIP 资源包。',
        'Link requests tag: {tag}. Confirm that selection below.': '链接指定标签：{tag}。请在下方确认选择。', 'Only part of the release history is listed. Use an exact release URL for an older version.': '这里只列出部分发布历史。较旧版本请使用确切的发布链接。',
        'No published releases found. Ask the author for a built plugin ZIP, or download and inspect a local plugin folder.': '未找到已发布的版本。请向作者获取构建好的插件 ZIP，或下载后检查本地插件文件夹。',
        'Reading GitHub releases...': '正在读取 GitHub 发布版本…', 'Downloading and validating the selected ZIP. No plugin is registered or enabled yet.': '正在下载并校验所选 ZIP，尚未注册或启用插件。',
        'GitHub task did not return a job ID. No installation was submitted.': 'GitHub 任务未返回任务 ID，没有提交安装。', 'GitHub task response did not match the requested job.': 'GitHub 响应与请求的任务不匹配。',
        'Reading releases: {stage}': '正在读取发布版本：{stage}', 'Preparing package: {stage}': '正在准备插件包：{stage}', 'Reading releases...': '正在读取发布版本…', 'Preparing package...': '正在准备插件包…',
        'fetching-releases': '读取发布信息', 'downloading-and-validating': '下载并校验', 'No installation has been submitted.': '尚未提交安装。',
        'GitHub task cancelled. No installation was submitted; temporary download files may remain.': 'GitHub 任务已取消，没有提交安装；可能保留临时下载文件。',
        'GitHub task cancelled. Late results will be ignored. No installation was submitted; temporary download files may remain.': 'GitHub 任务已取消，迟到结果会被忽略。没有提交安装；可能保留临时下载文件。',
        'GitHub task failed. No installation was submitted.': 'GitHub 任务失败，没有提交安装。', 'GitHub task returned an unknown status.': 'GitHub 任务返回了未知状态。', 'Task status unavailable: {error}': '无法获取任务状态：{error}',
        'Check the same task again, or cancel. No new download or installation is started by checking.': '可再次查询原任务或取消。查询不会发起新的下载或安装。', 'Enter a GitHub URL.': '请输入 GitHub 链接。',
        'Selected release: {tag}. Choose the exact plugin ZIP asset.': '已选发布版本：{tag}。请选择确切的插件 ZIP 资源包。', 'Choose an exact release.': '请选择确切的发布版本。',
        'This release has no ZIP assets. Repository source archives are not plugin release packages. Ask the author for a built package or use local folder import.': '此版本没有 ZIP 资源包。仓库源码压缩包不是插件发布包。请向作者获取已构建的包，或从本地文件夹导入。',
        'Download and validate this asset before granting permissions.': '授权前请先下载并校验此资源包。', '{asset} ({bytes} bytes)': '{asset}（{bytes} 字节）', '{tag} (prerelease){name}': '{tag}（预发布）{name}',
        'Validating the retained package and comparing permissions...': '正在校验保留的插件包并比较权限…', 'Permission details are unavailable.': '无法获取权限详情。',
        'Managed version history is unavailable or its cursor is invalid.': '无法获取托管版本历史，或分页游标无效。', 'Managed version history is incomplete.': '托管版本历史不完整。',
        'The installed version changed. Reopen details to refresh the history.': '已安装版本发生变化，请重新打开详情以刷新历史。', 'Rollback uses an already retained package. Review its source and permissions again before applying.': '回退使用已保留的插件包。应用前请重新检查来源和权限。', '{version} · {tag} · Current': '{version} · {tag} · 当前版本',
        'Remove this plugin’s registration and disable it. Source files and plugin data are kept by default. Selecting deletion below removes the source folder and all its contents.': '取消此插件的注册并停用。默认保留源文件和插件数据；勾选下方选项将删除源文件夹及其全部内容。',
        'This folder could not be recognized as a plugin. Check the path and codlet.json.': '无法识别此文件夹中的插件，请检查路径和 codlet.json。', 'Error details': '错误详情',
        'Revoke {permission}. This stops the package and its running dependents. To grant it again, import the local folder and confirm its permissions.': '撤销 {permission}，并停止此插件及运行中的依赖方。重新授权时，请导入本地文件夹并确认权限。',
        'Revoke {permission}. This stops the package and its running dependents. To grant it again, select a managed version and confirm its permissions again.': '撤销 {permission}，并停止此插件及运行中的依赖方。重新授权时，请选择托管版本并重新确认权限。',
        'The source folder could not be checked. You can still remove registration and keep files.': '无法检查源文件夹，仍可取消注册并保留文件。',
        'The source folder is missing or moved. Removing registration is still available.': '源文件夹已缺失或移动，仍可取消注册。', 'Source deletion is unavailable. Removing registration keeps the remaining files.': '无法删除来源目录。取消注册会保留现有文件。',
        'Source folder: {path}': '源文件夹：{path}', 'The source folder could not be opened.': '无法打开源文件夹。',
        'Current Codlet version: {version}': '当前 Codlet 版本：{version}', 'Codlet {version} is available.': 'Codlet {version} 可更新。', 'Downloading update: {percent}%': '正在下载更新：{percent}%',
        'Codlet {version} is ready to install.': 'Codlet {version} 已准备好安装。', 'Update failed.': '更新失败。', 'Automatic installation is unavailable for this launch.': '本次启动无法自动安装更新。'
    });
    const messages = { en: Object.fromEntries(Object.keys(TRANSLATIONS).map(key => [key, key])), zh: TRANSLATIONS };
    const templates = Object.keys(TRANSLATIONS).filter(key => key.includes('{')).map(key => {
        const names = [];
        const pattern = key.split(/(\{\w+\})/).map(part => /^\{\w+\}$/.test(part) ? (names.push(part.slice(1, -1)), '([\\s\\S]*?)') : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('');
        return { key, names, regex: new RegExp('^' + pattern + '$') };
    }).sort((a, b) => b.key.replace(/\{\w+\}/g, '').length - a.key.replace(/\{\w+\}/g, '').length);
    const literal = value => ({ literal: value });
    const resolveText = value => typeof value === 'function' ? value() : value;
    function translate(value) {
        value = resolveText(value);
        if (value && typeof value === 'object' && Object.hasOwn(value, 'literal')) return String(resolveText(value.literal) ?? '');
        const text = String(value ?? '');
        const locale = runtimeContext?.i18n?.locale === 'zh' ? 'zh' : 'en';
        if (locale === 'en' || !text) return text;
        if (text.includes('\n')) return text.split('\n').map(translate).join('\n');
        let key = Object.hasOwn(TRANSLATIONS, text) ? text : null, values = {};
        if (!key) for (const template of templates) {
            const match = template.regex.exec(text);
            if (match) { key = template.key; values = Object.fromEntries(template.names.map((name, index) => [name, match[index + 1]])); break; }
        }
        if (!key) return text.includes('\n') ? text.split('\n').map(translate).join('\n') : text;
        for (const name of ['description', 'compatibility', 'platforms', 'status', 'state', 'operation', 'before', 'after', 'permissions', 'capabilities', 'stage']) if (Object.hasOwn(values, name)) values[name] = translate(values[name]);
        return runtimeContext?.i18n?.t ? runtimeContext.i18n.t(messages, key, values) : TRANSLATIONS[key].replace(/\{(\w+)\}/g, (_, name) => values[name] ?? `{${name}}`);
    }
    function bindText(node, slot, source) {
        if (!textBindings.has(node)) textBindings.set(node, new Map());
        textBindings.get(node).set(slot, source);
        const value = translate(source);
        if (slot === 'text') node.textContent = value; else node.setAttribute(slot, value);
    }
    function setText(node, source) {
        if (['button', 'a'].includes(node.tagName?.toLowerCase())) {
            let caption = buttonCaptions.get(node);
            if (!caption) { node.textContent = ''; caption = ui.element('span'); node.appendChild(caption); buttonCaptions.set(node, caption); }
            bindText(caption, 'text', source);
        } else bindText(node, 'text', source);
    }
    function setLabel(node, source) { bindText(node, 'aria-label', source); }
    function guiButton(options) {
        const control = ui.button({ ...options, text: translate(options.text), ...(options.label !== undefined ? { label: translate(options.label) } : {}) });
        if (options.text !== undefined) setText(control, options.text);
        if (options.label !== undefined) setLabel(control, options.label);
        return control;
    }
    function guiSwitch(options) { const control = ui.switch({ ...options, label: translate(options.label) }); setLabel(control, options.label); return control; }
    function backButton(parent, context) {
        const back = ui.backButton({ text: translate('Back'), label: translate('Back') });
        setLabel(back, 'Back'); bindText(back.children[1], 'text', 'Back');
        parent.appendChild(back); ui.on(back, 'click', () => backToPlugins(context)); return back;
    }
    function refreshLanguage(context) {
        hideTooltip();
        const focused = document.activeElement;
        let focusedRow = focused;
        while (focusedRow && !focusedRow.getAttribute?.('data-codlet-plugin')) focusedRow = focusedRow.parentElement;
        const focusedId = focusedRow?.getAttribute('data-codlet-plugin');
        const focusedIndex = focusedRow && focused.parentElement === focusedRow.children[1] ? Array.from(focusedRow.children[1].children).indexOf(focused) : -1;
        if (confirmationSelection?.id) confirmationSelection.name = pluginName(visiblePlugins.find(plugin => plugin.id === confirmationSelection.id) ?? { id: confirmationSelection.id });
        if (pendingOperation) pendingOperation.name = pluginName(visiblePlugins.find(plugin => plugin.id === pendingOperation.pluginId) ?? { id: pendingOperation.pluginId, name: pendingOperation.name });
        for (const [node, entries] of textBindings) {
            if (!node.isConnected) { textBindings.delete(node); continue; }
            for (const [slot, source] of entries) bindText(node, slot, source);
        }
        renderedPlugins.forEach(entry => { entry.snapshot = ''; });
        if (pluginList && panel?.open) renderFilteredPlugins(context, true);
        if (focusedId && focusedIndex >= 0) focus(renderedPlugins.get(focusedId)?.row.children[1].children[focusedIndex]);
        renderAction();
    }

    function waitForDocument() {
        if (document.documentElement && document.body) return Promise.resolve();
        return new Promise(resolve => {
            const finish = () => {
                document.removeEventListener('DOMContentLoaded', finish);
                cancelDocumentWait = null;
                resolve();
            };
            cancelDocumentWait = finish;
            document.addEventListener('DOMContentLoaded', finish, { once: true });
        });
    }

    function addText(parent, tag, className, text) {
        const element = tag === 'button' ? guiButton({ text, variant: className === 'codlet-confirm' ? 'danger' : 'default' })
            : ui.element(tag, { role: ROLE_BY_CLASS[className] });
        element.className = className;
        if (tag !== 'button' && text !== '') setText(element, text);
        parent.appendChild(element);
        return element;
    }

    function iconButton(parent, name, label) {
        const control = guiButton({ label, variant: name === 'close' ? 'close' : 'icon' });
        control.className = 'codlet-icon-button';
        parent.appendChild(control);
        installTooltip(control, label);
        control.appendChild(ui.icon(name));
        return control;
    }

    function hideTooltip() {
        if (tooltipTimer !== null) clearTimeout(tooltipTimer);
        tooltipTimer = null;
        tooltipControl?.removeAttribute('aria-describedby');
        if (tooltip && ui) removeOwned(tooltip);
        tooltip = tooltipControl = null;
    }

    function installTooltip(control, text) {
        const schedule = () => {
            hideTooltip();
            tooltipControl = control;
            const epoch = lifecycle;
            tooltipTimer = setTimeout(() => {
                tooltipTimer = null;
                if (epoch !== lifecycle || !panel?.open || panel.hidden || !control.isConnected || control.disabled) return hideTooltip();
                tooltip = addText(panel, 'div', 'codlet-tooltip', text);
                tooltip.id = `${panel.id}-tooltip`;
                tooltip.setAttribute('role', 'tooltip');
                control.setAttribute('aria-describedby', tooltip.id);
                const container = panel.getBoundingClientRect();
                const anchor = control.getBoundingClientRect();
                const bounds = tooltip.getBoundingClientRect();
                const width = bounds.width || 180, height = bounds.height || 28;
                const x = Math.max(8, Math.min((anchor.left ?? container.left) - container.left, container.right - container.left - width - 8));
                const below = anchor.bottom - container.top + 8;
                const y = below + height <= container.bottom - container.top - 8 ? below : Math.max(8, (anchor.top ?? anchor.bottom) - container.top - height - 8);
                tooltip.style.left = `${x}px`;
                tooltip.style.top = `${y}px`;
            }, 280);
        };
        const cancel = () => { if (tooltipControl === control) hideTooltip(); };
        ui.on(control, 'pointerenter', schedule);
        ui.on(control, 'pointerleave', cancel);
        ui.on(control, 'pointerdown', cancel);
        ui.on(control, 'focusin', () => { if (control.matches?.(':focus-visible')) schedule(); });
        ui.on(control, 'focusout', cancel);
    }

    function removeOwned(node) {
        for (const target of textBindings.keys()) if (target === node || node.contains(target)) textBindings.delete(target);
        ui.remove(node);
    }

    function pluginName(plugin) {
        const locale = runtimeContext?.i18n?.locale === 'zh' ? 'zh' : 'en';
        const name = plugin.i18n?.[locale]?.name || plugin.name;
        return typeof name === 'string' && name.trim() ? name.trim() : plugin.id;
    }

    function requestDisable(context, plugin, origin) {
        if (pendingOperation || action !== 'idle' || !panel?.open || panel.hidden) return;
        const dependents = Array.isArray(plugin.disableDependents) ? plugin.disableDependents.filter(id => typeof id === 'string' && id !== plugin.id) : [];
        const closesGui = plugin.id === context.pluginId || dependents.includes(context.pluginId);
        if (!dependents.length && !closesGui) return managePlugin(context, plugin.id, 'disable');
        confirmationSelection = { id: plugin.id, name: pluginName(plugin), cascade: dependents.length > 0 };
        setText(confirmationCopy, () => {
            const dependentNames = dependents.map(id => pluginName(visiblePlugins.find(candidate => candidate.id === id) ?? { id }));
            return `${dependentNames.length ? `This will also disable: ${dependentNames.join(', ')}.\n` : ''}${closesGui ? 'The Codlet GUI will close in all open windows. Re-enable the plugins from the launcher to restore it.' : 'These plugins will stay disabled until you enable them again.'}`;
        });
        removalPreview = null; removalBusy = false; removeSourceChoice.parentElement.hidden = true;
        actionOrigin = origin;
        action = 'confirm';
        renderAction();
        focus(cancelButton);
    }

    function findMount() {
        if (!mountToken) return null;
        return Array.from(document.querySelectorAll(`[${MOUNT_ATTRIBUTE}]`))
            .find(element => element.getAttribute(MOUNT_ATTRIBUTE) === mountToken) ?? null;
    }

    function installStyle() {
        style = document.createElement('style');
        style.setAttribute(STYLE_ATTRIBUTE, 'codlet');
        // Shared control geometry and theme recipes belong to codex.ui.appearance.
        // This consumer owns its viewport anchor, business layout and tooltips.
        style.textContent = `
            [${BUTTON_ATTRIBUTE}] { pointer-events:auto; }
            [${PANEL_ATTRIBUTE}] { max-height:calc(100dvh - var(--codlet-available-top,36px) - 32px); }
            [${PANEL_ATTRIBUTE}][data-codlet-view="confirmation"] { width:420px; }
            [${PANEL_ATTRIBUTE}] *, [${PANEL_ATTRIBUTE}] *::before, [${PANEL_ATTRIBUTE}] *::after { box-sizing:border-box; }
            [${PANEL_ATTRIBUTE}][hidden], [${PANEL_ATTRIBUTE}] [hidden], [${BUTTON_ATTRIBUTE}][hidden] { display:none!important; }
            [${PANEL_ATTRIBUTE}] .codlet-section-header { display:flex; align-items:center; justify-content:space-between; gap:16px; min-height:46px; padding-bottom:6px; }
            [${PANEL_ATTRIBUTE}] .codlet-panel-header { display:flex;align-items:center;gap:8px; }
            [${PANEL_ATTRIBUTE}] .codlet-header-brand { display:flex;align-items:baseline;gap:8px;min-width:0;margin-right:auto; }
            [${PANEL_ATTRIBUTE}] .codlet-runtime-version { font-size:12px;color:var(--codlet-ui-secondary,GrayText);font-weight:400; }
            [${PANEL_ATTRIBUTE}] .codlet-icon-button[aria-busy="true"] svg { animation:codlet-spin 1.2s linear infinite; }
            @keyframes codlet-spin { to { transform:rotate(360deg); } }
            @media (prefers-reduced-motion:reduce) { [${PANEL_ATTRIBUTE}] .codlet-icon-button[aria-busy="true"] svg { animation:none; } }
            [${PANEL_ATTRIBUTE}] .codlet-icon-button { display:inline-flex;align-items:center;justify-content:center;min-width:32px;min-height:32px;flex:0 0 32px; }
            [${PANEL_ATTRIBUTE}] .codlet-search-toolbar { display:flex;align-items:center;gap:8px;margin-bottom:10px; }
            [${PANEL_ATTRIBUTE}] .codlet-search-toolbar input { flex:1;min-width:0; }
            [${PANEL_ATTRIBUTE}] .codlet-import-button { display:inline-flex;align-items:center;justify-content:center;gap:6px;white-space:nowrap;min-height:32px; }
            [${PANEL_ATTRIBUTE}] .codlet-source-tabs { display:flex;gap:4px;padding:3px;border-radius:8px;background:var(--codlet-ui-hover,ButtonFace); }
            [${PANEL_ATTRIBUTE}] .codlet-source-tabs button { flex:1;min-height:32px;border:0;box-shadow:none;background:transparent; }
            [${PANEL_ATTRIBUTE}] .codlet-source-tabs button[aria-selected="true"] { background:var(--codlet-ui-surface,Canvas);box-shadow:0 1px 3px rgb(0 0 0 / 12%); }
            [${PANEL_ATTRIBUTE}] .codlet-folder-input { display:flex;align-items:center;gap:6px; }
            [${PANEL_ATTRIBUTE}] .codlet-folder-input input { flex:1; }
            [${PANEL_ATTRIBUTE}] .codlet-community-link { display:inline-flex;align-items:center;gap:5px;align-self:flex-start;text-decoration:underline;text-underline-offset:3px;font-size:13px;color:var(--codlet-ui-secondary,GrayText); }
            [${PANEL_ATTRIBUTE}] .codlet-client-status { margin:8px 0 2px;font-size:12px;line-height:1.5;color:var(--codlet-ui-secondary,GrayText); }
            [${PANEL_ATTRIBUTE}] .codlet-details-heading { display:flex;align-items:center;gap:8px; }
            [${PANEL_ATTRIBUTE}] .codlet-details-heading h2 { margin-right:auto; }
            [${PANEL_ATTRIBUTE}] .codlet-section-title { margin:0; font-size:inherit; font-weight:var(--codlet-ui-font-weight-medium,500); }
            [${PANEL_ATTRIBUTE}] .codlet-plugin-list:empty { display:none; }
            [${PANEL_ATTRIBUTE}] .codlet-plugin-state { max-width:88px; font-size:var(--codlet-ui-font-small,13px); line-height:calc(var(--codlet-ui-font-small,13px) * 18 / 13); text-align:right; color:var(--codlet-ui-secondary,GrayText); }
            [${PANEL_ATTRIBUTE}] .codlet-confirmation-copy { margin:0; color:var(--codlet-ui-muted,GrayText); line-height:1.5; }
            [${PANEL_ATTRIBUTE}] .codlet-confirmation-copy code { font:inherit; color:var(--codlet-ui-fg,CanvasText); }
            [${PANEL_ATTRIBUTE}] .codlet-local-page { display:flex; flex-direction:column; gap:16px; min-width:0; }
            [${PANEL_ATTRIBUTE}] .codlet-local-toolbar { display:flex; align-items:center; flex-wrap:wrap; gap:8px; }
            [${PANEL_ATTRIBUTE}] .codlet-local-toolbar > :first-child { margin-right:auto; }
            [${PANEL_ATTRIBUTE}] .codlet-field { display:flex; flex-direction:column; gap:6px; }
            [${PANEL_ATTRIBUTE}] .codlet-field-label { font-weight:500; }
            [${PANEL_ATTRIBUTE}] .codlet-field-input { width:100%; min-width:0; padding:8px 10px; border:1px solid var(--codlet-ui-border,ButtonBorder); border-radius:6px; background:var(--codlet-ui-input-bg,var(--codlet-ui-surface,Canvas)); color:inherit; font:inherit; line-height:1.45; }
            [${PANEL_ATTRIBUTE}] textarea.codlet-field-input { min-height:64px; resize:vertical; }
            [${PANEL_ATTRIBUTE}] .codlet-field-input:focus-visible { outline:2px solid var(--codlet-ui-accent,Highlight); outline-offset:2px; }
            [${PANEL_ATTRIBUTE}] .codlet-local-copy { margin:0; color:var(--codlet-ui-secondary,GrayText); font-size:var(--codlet-ui-font-small,13px); line-height:1.5; white-space:pre-line; overflow-wrap:anywhere; }
            [${PANEL_ATTRIBUTE}] .codlet-local-preview { display:flex; flex-direction:column; gap:14px; }
            [${PANEL_ATTRIBUTE}] .codlet-permission-choice { display:flex; align-items:flex-start; gap:10px; line-height:1.45; }
            [${PANEL_ATTRIBUTE}] .codlet-permission-choice input { flex:0 0 auto; margin:4px 0 0; accent-color:var(--codlet-ui-accent,Highlight); }
            [${PANEL_ATTRIBUTE}] .codlet-permission-line { display:flex; align-items:center; gap:12px; }
            [${PANEL_ATTRIBUTE}] .codlet-permission-line > :first-child { flex:1; min-width:0; }
            [${PANEL_ATTRIBUTE}] .codlet-details-button { flex:0 0 auto; }
            [${PANEL_ATTRIBUTE}] .codlet-tooltip { position:absolute; z-index:10; pointer-events:none; max-width:min(360px,calc(100% - 16px)); max-height:140px; overflow:hidden; padding:6px 9px; border:1px solid var(--codlet-ui-border,ButtonBorder); border-radius:6px; background:var(--codlet-ui-surface-raised,Canvas); color:var(--codlet-ui-fg,CanvasText); font-size:var(--codlet-ui-font-small,13px); font-weight:400; line-height:1.4; white-space:pre-line; box-shadow:0 2px 8px rgb(0 0 0 / 15%); }
        `;
        document.documentElement.appendChild(style);
    }

    function isOwned(element) {
        return !!element && (element === button || panel?.contains(element) === true);
    }

    function focus(element) {
        if (element?.isConnected && !element.disabled) element.focus({ preventScroll: true });
    }

    function renderAction() {
        hideTooltip();
        settingsSection.hidden = action !== 'idle' || page !== 'plugins';
        importSection.hidden = action !== 'idle' || page !== 'import';
        detailsSection.hidden = action !== 'idle' || page !== 'details';
        updateSection.hidden = action !== 'idle' || page !== 'updates';
        confirmation.hidden = action === 'idle';
        panel.setAttribute('data-codlet-view', action === 'idle' ? page === 'plugins' ? 'settings' : page : 'confirmation');
        const selectedName = confirmationSelection?.name || 'Codlet';
        const verb = confirmationSelection?.action === 'remove' ? 'Remove' : confirmationSelection?.action === 'revoke' ? 'Revoke permission for' : 'Disable';
        const accessibleTitle = action === 'idle' ? page === 'import' ? importMode === 'local' ? 'Import local plugin' : importOperation === 'update' ? 'Update GitHub plugin' : importOperation === 'rollback' ? 'Roll back plugin' : 'Import from GitHub' : page === 'details' ? pluginName(detailsPlugin ?? { id: 'Plugin details' }) : page === 'updates' ? 'Updates' : 'Codlet'
            : confirmationSelection?.action === 'installRuntimeUpdate' ? 'Install and restart Codlet?' : action === 'done' ? `${selectedName} disabled` : `${verb} ${selectedName}?`;
        setLabel(panel, accessibleTitle);
        setLabel(confirmation, accessibleTitle);
        setText(confirmationHeading, accessibleTitle);
        if (action === 'idle') panel.removeAttribute('aria-describedby');
        else panel.setAttribute('aria-describedby', `${panel.id}-disable-consequence`);
        refreshButton.disabled = action !== 'idle';
        confirmButton.disabled = action === 'pending' || action === 'done' || removalBusy;
        cancelButton.disabled = action === 'pending' || action === 'done';
        setText(confirmButton, action === 'pending' ? 'Disabling...' : confirmationSelection?.action === 'installRuntimeUpdate' ? 'Install and restart' : confirmationSelection?.action === 'remove' ? 'Remove' : confirmationSelection?.action === 'revoke' ? 'Revoke' : 'Disable');
        confirmationStatus.hidden = action !== 'failed' && action !== 'done';
        setText(confirmationStatus, action === 'failed' ? actionError : action === 'done' ? 'Codlet is disabled.' : '');
        if (actionOrigin?.isConnected) {
            actionOrigin.checked = true;
            actionOrigin.disabled = action !== 'idle' || pendingOperation !== null;
        }
    }

    function cancelAction() {
        if (action !== 'confirm' && action !== 'failed') return;
        action = 'idle';
        removalRequest += 1; removalBusy = false; removalPreview = null;
        removeSourceChoice.checked = false; removeSourceChoice.parentElement.hidden = true;
        confirmationSelection = null;
        renderAction();
        focus(actionOrigin?.isConnected ? actionOrigin : refreshButton);
    }

    function addLoadControl(context, plugin, controls, loadAction) {
        const name = pluginName(plugin);
        const load = loadAction === 'reload'
            ? iconButton(controls, 'refresh', `Reload ${name}${plugin.disableDependents?.length ? ' and dependent plugins' : ''}`)
            : addText(controls, 'button', '', 'Start');
        load.type = 'button';
        setLabel(load, `${loadAction === 'reload' ? 'Reload' : 'Start'} ${name}`);
        load.addEventListener('click', () => managePlugin(context, plugin.id, loadAction));
        mutationControls.add(load);
        load.disabled = pendingOperation !== null;
    }

    function createPluginRow(context, plugin) {
        const execution = plugin.execution?.kind === 'host' ? plugin.execution : null;
        const executionState = execution?.state === 'active' && execution.rendererActive === false ? 'Waiting for renderer'
            : execution?.state === 'starting' ? 'Starting'
            : execution?.state === 'active' ? 'Active'
            : execution?.state === 'stopping' ? 'Stopping'
            : execution?.state === 'failed' ? 'Failed'
            : execution?.state === 'exited' ? 'Exited' : null;
        const executionError = typeof execution?.error === 'string' && execution.error.length > 0
            ? execution.error : execution?.state === 'failed' ? 'Host process failed' : null;
        const name = pluginName(plugin);
        const metadata = [plugin.version]
            .filter(value => typeof value === 'string' && value.length > 0);
        const parts = ui.row({ label: name, description: metadata.join(' / ') });
        const row = parts.element, copy = parts.copy;
        row.setAttribute('data-codlet-plugin', plugin.id);
        row.className = 'codlet-plugin-row'; copy.className = 'codlet-plugin-copy';
        parts.label.className = 'codlet-plugin-name'; parts.description.className = 'codlet-plugin-version';
        parts.controls.className = 'codlet-plugin-actions';
        const description = pluginDescription(plugin);
        if (description) installTooltip(copy, literal(() => pluginDescription(plugin)));
        if (plugin.registered === false && plugin.loaded === true) {
            addText(copy, 'div', 'codlet-plugin-version', 'Registration removed; still loaded');
        } else if (plugin.validation?.status === 'not_loaded') {
            addText(copy, 'div', 'codlet-plugin-version', 'Registered, not loaded');
        }
        if (updateReply) renderUpdateIndicator(updateReply);
        if (executionError) {
            addText(copy, 'div', 'codlet-plugin-version', executionError);
        } else if (plugin.validation?.status === 'failed') {
            const message = plugin.validation.error?.message;
            addText(copy, 'div', 'codlet-plugin-version', typeof message === 'string' ? message : 'Plugin validation failed');
        }
        if (plugin.registered !== false) {
            const details = addText(parts.controls, 'button', 'codlet-details-button', 'Details');
            setLabel(details, `Details for ${name}`);
            ui.on(details, 'click', () => showDetails(context, plugin));
            mutationControls.add(details);
            details.disabled = pendingOperation !== null;
        }
        const state = executionState ?? (plugin.active === true ? 'Active'
            : plugin.validation?.status === 'failed' ? 'Unavailable'
            : plugin.enabled === true ? 'Not active' : 'Disabled');
        if (plugin.id === context.pluginId && plugin.active === true && plugin.enabled === true) {
            const controls = parts.controls;
            addText(controls, 'div', 'codlet-plugin-state', state);
            addLoadControl(context, plugin, controls, 'reload');
            const toggle = guiSwitch({ label: 'Enable Codlet GUI', checked: true });
            toggle.className = 'codlet-toggle';
            toggle.type = 'checkbox';
            toggle.checked = true;
            toggle.setAttribute('role', 'switch');
            setLabel(toggle, 'Enable Codlet GUI');
            ui.on(toggle, 'change', () => {
                if (toggle.checked || action !== 'idle' || pendingOperation || !row.isConnected || panel.hidden) return;
                return requestDisable(context, plugin, toggle);
            });
            mutationControls.add(toggle);
            toggle.disabled = pendingOperation !== null;
            controls.appendChild(toggle);
        } else {
            if (plugin.registered !== false || plugin.loaded === true) {
                const controls = parts.controls;
                addText(controls, 'div', 'codlet-plugin-state', state);
                if (plugin.registered === false) {
                    const stop = addText(controls, 'button', '', 'Stop');
                    stop.type = 'button';
                    setLabel(stop, `Stop ${name}`);
                    ui.on(stop, 'click', () => requestDisable(context, plugin, stop));
                    mutationControls.add(stop);
                    stop.disabled = pendingOperation !== null;
                    return row;
                }
                if (plugin.enabled === true) {
                    const loadAction = plugin.loaded === true || Number.isSafeInteger(plugin.generation) ? 'reload' : 'enable';
                    addLoadControl(context, plugin, controls, loadAction);
                }
                const toggle = guiSwitch({ label: `Enable ${name}`, checked: plugin.enabled === true });
                toggle.className = 'codlet-toggle';
                toggle.type = 'checkbox';
                toggle.checked = plugin.enabled === true;
                toggle.setAttribute('role', 'switch');
                setLabel(toggle, `Enable ${name}`);
                ui.on(toggle, 'change', () => {
                    const nextAction = toggle.checked ? 'enable' : 'disable';
                    toggle.checked = plugin.enabled === true;
                    return nextAction === 'disable' ? requestDisable(context, plugin, toggle) : managePlugin(context, plugin.id, nextAction);
                });
                controls.appendChild(toggle);
                mutationControls.add(toggle);
                toggle.disabled = pendingOperation !== null;
            } else {
                addText(parts.controls, 'div', 'codlet-plugin-state', state);
            }
        }
        return row;
    }

    function updatePluginRows(context, plugins) {
        const focused = document.activeElement;
        const focusLabel = pluginList.contains(focused) ? focused.getAttribute('aria-label') : null;
        const ids = new Set(plugins.map(plugin => plugin.id));
        for (const [id, entry] of renderedPlugins) {
            if (!ids.has(id)) {
                removeOwned(entry.row);
                renderedPlugins.delete(id);
            }
        }
        plugins.forEach((plugin, index) => {
            const snapshot = JSON.stringify(plugin);
            let entry = renderedPlugins.get(plugin.id);
            if (!entry || entry.snapshot !== snapshot) {
                if (entry) removeOwned(entry.row);
                entry = { snapshot, row: createPluginRow(context, plugin) };
                renderedPlugins.set(plugin.id, entry);
            }
            if (pluginList.children[index] !== entry.row) {
                pluginList.insertBefore(entry.row, pluginList.children[index] ?? null);
            }
        });
        for (const control of mutationControls) {
            if (!control.isConnected) mutationControls.delete(control);
        }
        if (focusLabel && !focused.isConnected) {
            focus([...mutationControls].find(control => control.getAttribute('aria-label') === focusLabel) ?? refreshButton);
        }
    }

    function pluginDescription(plugin) {
        const locale = runtimeContext?.i18n?.locale === 'zh' ? 'zh' : 'en';
        return plugin.i18n?.[locale]?.description || plugin.description || '';
    }

    function renderFilteredPlugins(context, preserveStatus = false) {
        const query = (searchInput?.value ?? '').trim().toLowerCase();
        const terms = query.split(/\s+/).filter(Boolean);
        const plugins = visiblePlugins.filter(plugin => !query || terms.every(term => [plugin.id, plugin.name, plugin.description,
            plugin.i18n?.zh?.name, plugin.i18n?.zh?.description, plugin.i18n?.en?.name, plugin.i18n?.en?.description]
            .filter(value => typeof value === 'string').join(' ').toLowerCase().includes(term)));
        updatePluginRows(context, plugins);
        if (!pendingOperation && !preserveStatus) {
            managementStatus.hidden = plugins.length > 0;
            setText(managementStatus, plugins.length ? '' : query ? 'No matching plugins' : 'No plugins');
        }
    }

    function renderClientStatus(status) {
        const lines = [];
        if (status?.status === 'officialUpdateAvailable' || status?.officialUpdateAvailable === true) lines.push('Official client update available. A routine update usually does not affect Codlet, but not every plugin is guaranteed to work.');
        if (status?.status === 'unmatched') lines.push('This Codlet version is not matched to the latest client version. This usually does not affect use, but not every plugin is guaranteed to work.');
        if (status?.status === 'matched') lines.push('This Codlet version matches the latest client version.');
        setText(clientStatusLine, lines.join('\n')); clientStatusLine.hidden = lines.length === 0;
    }

    function cancelUpdatePolling() { if (updateTimer !== null) clearTimeout(updateTimer); updateTimer = null; }
    function cancelHeaderPolling() { if (headerUpdateTimer !== null) clearTimeout(headerUpdateTimer); headerUpdateTimer = null; headerUpdateRequest += 1; }
    function updateActionLabel() {
        return updateReply?.phase === 'available' ? 'Download update' : updateReply?.phase === 'downloaded' && updateReply.installAvailable ? 'Install and restart'
            : updateReply?.phase === 'downloading' ? updateReply.totalBytes ? `Downloading update: ${Math.min(100, Math.round(updateReply.downloadedBytes / updateReply.totalBytes * 100))}%` : 'Downloading update...'
            : updateReply?.phase === 'checking' ? 'Checking for updates...' : 'Check for updates';
    }
    function renderUpdateIndicator(reply) {
        if (!updateButton) return;
        const development = reply?.configured === false || reply?.phase === 'development';
        developmentLabel.hidden = !development;
        updateButton.hidden = !reply || development;
        const busy = ['checking', 'downloading', 'installRequested'].includes(reply?.phase);
        updateButton.disabled = busy || updateBusy || managementBusy || pendingOperation !== null || action !== 'idle';
        updateButton.setAttribute('aria-busy', String(busy));
        setLabel(updateButton, updateActionLabel);
        const icon = reply?.phase === 'available' ? 'download' : reply?.phase === 'downloaded' ? 'restart' : busy ? 'spinner' : 'refresh';
        if (updateIconName !== icon) {
            for (const child of Array.from(updateButton.children)) removeOwned(child);
            updateButton.appendChild(ui.icon(icon)); updateIconName = icon;
        }
    }
    async function refreshHeaderUpdate(context) {
        if (!panel?.open || panel.hidden) return;
        if (headerUpdateTimer !== null) clearTimeout(headerUpdateTimer); headerUpdateTimer = null;
        const request = ++headerUpdateRequest, epoch = lifecycle;
        try {
            const reply = await context.rpc.request(RUNTIME_MANAGE_CAPABILITY, 'runtimeUpdateStatus', {});
            if (epoch !== lifecycle || request !== headerUpdateRequest || !panel?.open || panel.hidden || updateBusy) return;
            if (typeof reply?.currentVersion !== 'string' || typeof reply?.configured !== 'boolean') return;
            updateReply = reply; renderUpdateIndicator(reply);
            if (page === 'updates') renderUpdateStatus(context, reply);
        } catch (_) { /* A missing update service does not block plugin management. */ }
        finally {
            if (epoch === lifecycle && request === headerUpdateRequest && panel?.open && !panel.hidden && updateReply?.configured) headerUpdateTimer = setTimeout(() => { headerUpdateTimer = null; void refreshHeaderUpdate(context); }, 5000);
        }
    }
    function createUpdatePage(context, parent) {
        updateSection = addText(parent, 'section', 'codlet-local-page', ''); updateSection.hidden = true;
        backButton(updateSection, context);
        addText(updateSection, 'h2', 'codlet-section-title', 'Updates');
        updateStatus = addText(updateSection, 'p', 'codlet-local-copy', ''); updateStatus.setAttribute('role', 'status'); updateStatus.setAttribute('aria-live', 'polite');
        updateBody = addText(updateSection, 'div', 'codlet-local-preview', '');
    }
    function showUpdates(context, method = 'runtimeUpdateStatus') {
        if (pendingOperation || action !== 'idle' || !panel?.open || panel.hidden) return;
        cancelGitHubWork(); cancelUpdatePolling(); cancelHeaderPolling(); invalidatePreview();
        page = 'updates'; updateBusy = false; clearLocalBody(updateBody); renderAction();
        setText(updateStatus, 'Checking for updates...');
        return loadUpdateStatus(context, method);
    }
    async function loadUpdateStatus(context, method = 'runtimeUpdateStatus') {
        if (updateBusy || page !== 'updates' || !panel?.open || panel.hidden) return;
        cancelUpdatePolling(); updateBusy = true;
        renderUpdateIndicator(updateReply);
        const request = localRequest, epoch = lifecycle;
        for (const control of Array.from(updateBody.children).filter(node => node.tagName?.toLowerCase() === 'button')) control.disabled = true;
        const current = () => request === localRequest && epoch === lifecycle && page === 'updates' && panel?.open && !panel.hidden;
        try {
            const reply = await context.rpc.request(RUNTIME_MANAGE_CAPABILITY, method, {});
            if (!current()) return;
            if (typeof reply?.currentVersion !== 'string' || !['development', 'checking', 'upToDate', 'available', 'downloading', 'downloaded', 'installRequested', 'failed'].includes(reply.phase)) throw new Error('Update status is unavailable.');
            updateReply = reply; renderUpdateStatus(context, reply);
        } catch (error) {
            if (current()) { updateReply = null; clearLocalBody(updateBody); setText(updateStatus, `Update status is unavailable.\n${String(error?.message ?? error)}`); }
        } finally {
            if (current()) {
                updateBusy = false;
                renderUpdateIndicator(updateReply);
                if (!updateReply || ['checking', 'downloading', 'installRequested'].includes(updateReply.phase)) updateTimer = setTimeout(() => { updateTimer = null; void loadUpdateStatus(context); }, 1000);
            }
        }
    }
    function renderUpdateStatus(context, reply) {
        renderUpdateIndicator(reply);
        clearLocalBody(updateBody);
        const statuses = { development: 'This development build has no configured update source.', checking: 'Checking for updates...', upToDate: 'Codlet is up to date.', available: `Codlet ${reply.candidate?.version || ''} is available.`, downloading: reply.totalBytes ? `Downloading update: ${Math.min(100, Math.round(reply.downloadedBytes / reply.totalBytes * 100))}%` : 'Downloading update...', downloaded: `Codlet ${reply.candidate?.version || ''} is ready to install.`, installRequested: 'Installation was requested. Follow the update process to restart Codlet.', failed: `Update failed.\n${reply.error?.message || ''}` };
        setText(updateStatus, statuses[reply.phase]);
        addText(updateBody, 'p', 'codlet-local-copy', `Current Codlet version: ${reply.currentVersion}`);
        const control = (label, method, iconName) => {
            const button = guiButton({ text: label, label }); button.className = 'codlet-import-button';
            button.insertBefore(ui.icon(iconName), button.children[0]); updateBody.appendChild(button);
            ui.on(button, 'click', () => method === 'installRuntimeUpdate' ? requestInstallUpdate(context, button) : loadUpdateStatus(context, method));
        };
        if (reply.configured && !['checking', 'downloading', 'installRequested'].includes(reply.phase)) control('Check for Codlet updates', 'checkRuntimeUpdate', 'refresh');
        if (reply.phase === 'available') control('Download update', 'downloadRuntimeUpdate', 'download');
        if (reply.phase === 'downloaded' && reply.installAvailable) control('Install and restart', 'installRuntimeUpdate', 'restart');
        else if (reply.phase === 'downloaded' && reply.unavailableReason) addText(updateBody, 'p', 'codlet-local-copy', `Automatic installation is unavailable for this launch.\n${reply.unavailableReason}`);
    }
    function requestInstallUpdate(context, origin) {
        if (pendingOperation || updateBusy || action !== 'idle' || updateReply?.phase !== 'downloaded' || !updateReply.installAvailable || !panel?.open || panel.hidden) return;
        cancelUpdatePolling();
        confirmationSelection = { action: 'installRuntimeUpdate', name: 'Codlet' };
        removalRequest += 1; removalBusy = false; removalPreview = null; removeSourceChoice.parentElement.hidden = true;
        setText(confirmationCopy, 'The current client will restart and running local tasks will be interrupted.');
        action = 'confirm'; actionOrigin = origin; renderAction(); focus(cancelButton);
    }

    function operationMessage(message) {
        if (!panel?.open || panel.hidden || action !== 'idle') return;
        managementStatus.hidden = false;
        setText(managementStatus, message);
    }

    function setMutationBusy(busy) {
        managementBusy = busy;
        if (busy) hideTooltip();
        for (const control of mutationControls) {
            if (control.isConnected) control.disabled = busy;
        }
        if (updateReply) renderUpdateIndicator(updateReply);
    }

    async function finishOperation(context, expected, message) {
        if (pendingOperation !== expected) return;
        const epoch = lifecycle;
        pendingOperation = null;
        if (operationTimer !== null) clearTimeout(operationTimer);
        operationTimer = null;
        if (panel?.open && !panel.hidden) {
            await refreshPlugins(context);
            if (epoch === lifecycle && pendingOperation === null) operationMessage(message);
        }
    }

    async function checkOperation(context, expected = pendingOperation) {
        if (!expected?.operationId || pendingOperation !== expected || expected.checking) return;
        if (operationTimer !== null) clearTimeout(operationTimer);
        operationTimer = null;
        const epoch = lifecycle;
        expected.checking = true;
        let reply;
        try {
            reply = await context.rpc.request(RUNTIME_MANAGE_CAPABILITY, 'operation', { operationId: expected.operationId });
        } catch (_) {
            if (epoch === lifecycle && pendingOperation === expected) {
                operationMessage('Action status unavailable. Refresh to check again.');
            }
            expected.checking = false;
            return;
        }
        expected.checking = false;
        if (epoch !== lifecycle || pendingOperation !== expected) return;
        const operation = reply?.operation;
        if (operation?.operation_id !== expected.operationId ||
            operation.request?.plugin_id !== expected.pluginId || operation.request?.action !== expected.action) {
            operationMessage(reply?.error || 'Action status is no longer available. The action has not been repeated.');
            return;
        }
        if (reply.status === 'completed') {
            const completion = operation.completion;
            const report = completion?.kind === 'report' ? completion.report : null;
            const succeeded = report?.outcome === 'applied' || report?.outcome === 'unchanged';
            const message = succeeded
                ? `${expected.name}: ${{ enable: 'enabled', disable: 'disabled', reload: 'reloaded', import: report.desired_enabled ? 'imported and enabled' : 'imported, disabled', update: report.desired_enabled ? 'updated and enabled' : 'updated, disabled', rollback: report.desired_enabled ? 'rolled back and enabled' : 'rolled back, disabled', remove: expected.deleteSource ? 'removed' : 'removed; files kept', revoke: 'permission revoked' }[expected.action]}.${expected.action === 'remove' && report.message ? `\n${report.message}` : ''}`
                : completion?.error?.message || report?.message || 'The action finished with an error. Refresh for the current state.';
            await finishOperation(context, expected, message);
            return;
        }
        if (reply.status !== 'queued' && reply.status !== 'running') {
            operationMessage(reply?.error || 'The action was not confirmed. Refresh checks the same action without repeating it.');
            return;
        }
        operationMessage(`${expected.name}: ${reply.status === 'queued' ? 'waiting' : 'updating'}...`);
        if (panel?.open && !panel.hidden) {
            operationTimer = setTimeout(() => { operationTimer = null; void checkOperation(context, expected); }, 250);
        }
    }

    async function managePlugin(context, pluginId, nextAction, cascade = false, extra = {}, displayName = null) {
        if (pendingOperation || action !== 'idle' || !panel?.open || panel.hidden) return;
        const epoch = lifecycle;
        const expected = { pluginId, name: displayName || pluginName(visiblePlugins.find(plugin => plugin.id === pluginId) ?? { id: pluginId }), action: nextAction, operationId: null, checking: false, deleteSource: !!extra.remove_source };
        pendingOperation = expected;
        setMutationBusy(true);
        operationMessage(`${expected.name}: preparing...`);
        let prepared;
        try {
            prepared = await context.rpc.request(RUNTIME_MANAGE_CAPABILITY, 'prepare', { action: nextAction, plugin_id: pluginId, ...(cascade ? { cascade: true } : {}), ...extra });
        } catch (error) {
            if (epoch === lifecycle) await finishOperation(context, expected, error instanceof Error ? error.message : 'The action could not be prepared.');
            return;
        }
        if (epoch !== lifecycle || pendingOperation !== expected) return;
        if (prepared?.status !== 'prepared' || typeof prepared.operation?.operation_id !== 'string') {
            await finishOperation(context, expected, prepared?.error || 'The action could not be prepared.');
            return;
        }
        expected.operationId = prepared.operation.operation_id;
        let submitted;
        try {
            // One submission only. A lost reply is followed exclusively by
            // read-only queries for this exact server-issued receipt.
            submitted = await context.rpc.request(RUNTIME_MANAGE_CAPABILITY, 'submit', { operationId: expected.operationId });
        } catch (_) {
            submitted = null;
        }
        if (epoch !== lifecycle || pendingOperation !== expected) return;
        if (['busy', 'not_ready', 'stopping', 'expired', 'stale_host', 'invalid_request', 'not_running'].includes(submitted?.status)) {
            await finishOperation(context, expected, submitted.error || 'The action was not submitted. Try again when the runtime is ready.');
            return;
        }
        await checkOperation(context, expected);
    }

    async function disableSelf(context) {
        if (action !== 'confirm' && action !== 'failed') return;
        if (removalBusy) return;
        if (confirmationSelection?.action === 'installRuntimeUpdate') {
            confirmationSelection = null; action = 'idle'; page = 'updates'; renderAction();
            return loadUpdateStatus(context, 'installRuntimeUpdate');
        }
        if (confirmationSelection?.action === 'remove' || confirmationSelection?.action === 'revoke') {
            const selected = confirmationSelection;
            const extra = selected.permission ? { permission: selected.permission } : selected.action === 'remove' && removeSourceChoice.checked && removalPreview?.status === 'available'
                ? { remove_source: { registrationDigest: removalPreview.registrationDigest, sourceIdentity: removalPreview.sourceIdentity } } : {};
            confirmationSelection = null;
            removalRequest += 1; removalPreview = null; removeSourceChoice.checked = false; removeSourceChoice.parentElement.hidden = true;
            action = 'idle'; page = 'plugins';
            renderAction();
            return managePlugin(context, selected.id, selected.action, selected.cascade ?? false, extra);
        }
        if (confirmationSelection && (confirmationSelection.id !== context.pluginId || confirmationSelection.cascade)) {
            const selection = confirmationSelection;
            confirmationSelection = null;
            action = 'idle';
            renderAction();
            return managePlugin(context, selection.id, 'disable', selection.cascade);
        }
        const epoch = lifecycle;
        const moveFocus = confirmation.contains(document.activeElement);
        action = 'pending';
        renderAction();
        if (moveFocus) focus(closeButton);
        try {
            const result = await context.rpc.request(RUNTIME_MANAGE_CAPABILITY, 'disableSelf', null);
            if (epoch !== lifecycle) return;
            if (result?.enabled !== false || result?.pluginId !== context.pluginId) throw new Error('Disable was not confirmed');
            action = 'done';
        } catch (error) {
            if (epoch !== lifecycle) return;
            action = 'failed';
            actionError = error instanceof Error ? error.message : String(error);
        }
        if (panel.open && !panel.hidden) renderAction();
    }

    async function refreshPlugins(context) {
        if (!panel || panel.hidden || action !== 'idle') return;
        if (pendingOperation?.operationId) {
            await checkOperation(context);
            return;
        }
        const currentPanel = panel;
        const epoch = lifecycle;
        const request = ++panelRequest;
        hideTooltip();
        const initial = pluginList.children.length === 0;
        pluginList.hidden = initial;
        pluginList.setAttribute('aria-busy', 'true');
        setMutationBusy(true);
        managementStatus.hidden = false;
        setText(managementStatus, initial ? 'Loading plugins...' : 'Updating plugins...');
        try {
            const management = await context.rpc.request(RUNTIME_MANAGE_CAPABILITY, 'list', null);
            if (epoch !== lifecycle || panel !== currentPanel || !currentPanel.open || currentPanel.hidden || request !== panelRequest) return;
            if (!Array.isArray(management?.plugins) || management.plugins.some(plugin =>
                !plugin || typeof plugin.id !== 'string' || !plugin.id.length)) throw new Error('Plugin list unavailable');
            if (new Set(management.plugins.map(plugin => plugin.id)).size !== management.plugins.length) throw new Error('Plugin list contains duplicate IDs');
            visiblePlugins = management.plugins;
            localManagement = management.localManagement ?? null;
            importButton.hidden = localManagement?.available !== true;
            githubTab.disabled = management.githubManagement?.available !== true;
            setText(versionLabel, management.runtimeVersion ? literal(management.runtimeVersion) : '');
            renderClientStatus(management.clientStatus);
            setMutationBusy(false);
            renderFilteredPlugins(context);
            pluginList.hidden = false;
            if (typeof management.runtimeVersion === 'string') await refreshHeaderUpdate(context);
        } catch (error) {
            if (epoch !== lifecycle || panel !== currentPanel || !currentPanel.open || currentPanel.hidden || request !== panelRequest) return;
            setText(managementStatus, error?.code === 'rpc_timeout'
                ? 'Plugin list timed out. Refresh to try again.'
                : error instanceof Error ? error.message : 'Plugin list unavailable');
        }
        if (epoch === lifecycle && panel === currentPanel && currentPanel.open && !currentPanel.hidden && request === panelRequest) {
            pluginList.setAttribute('aria-busy', 'false');
            setMutationBusy(pendingOperation !== null);
        }
    }

    function createPanel(context) {
        panel = ui.element('dialog', { role: 'dialog', variant: 'settings' });
        panel.id = `codlet-panel-${context.generation}`;
        panel.setAttribute(PANEL_ATTRIBUTE, 'codlet');
        panel.setAttribute('data-codlet-generation', String(context.generation));
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-modal', 'true');
        setLabel(panel, 'Codlet');
        panel.hidden = true;
        const header = addText(panel, 'div', 'codlet-panel-header', '');
        const brand = addText(header, 'div', 'codlet-header-brand', '');
        panelTitle = addText(brand, 'h1', 'codlet-panel-title', 'Codlet');
        versionLabel = addText(brand, 'span', 'codlet-runtime-version', '');
        developmentLabel = addText(brand, 'span', 'codlet-runtime-version', 'Development'); developmentLabel.hidden = true;
        updateButton = iconButton(header, 'refresh', updateActionLabel); updateButton.hidden = true; updateIconName = 'refresh';
        mutationControls.add(updateButton);
        ui.on(updateButton, 'click', () => {
            if (updateButton.disabled || updateBusy) return;
            if (updateReply?.phase === 'downloaded' && updateReply.installAvailable) return requestInstallUpdate(context, updateButton);
            return showUpdates(context, updateReply?.phase === 'available' ? 'downloadRuntimeUpdate' : 'runtimeUpdateStatus');
        });
        closeButton = iconButton(header, 'close', 'Close Codlet');
        closeButton.className += ' codlet-dialog-close';
        ui.on(closeButton, 'click', () => setPanelOpen(false));
        const body = addText(panel, 'div', 'codlet-panel-body', '');
        settingsSection = addText(body, 'section', 'codlet-settings-section', '');
        const listActions = addText(settingsSection, 'div', 'codlet-search-toolbar', '');
        searchInput = ui.element('input'); searchInput.type = 'search'; searchInput.value = ''; searchInput.className = 'codlet-field-input';
        setLabel(searchInput, 'Search plugins'); bindText(searchInput, 'placeholder', 'Search plugins');
        listActions.appendChild(searchInput); ui.on(searchInput, 'input', () => renderFilteredPlugins(context));
        importButton = addText(listActions, 'button', 'codlet-import-button', 'Import');
        importButton.insertBefore(ui.icon('import'), importButton.children[0]);
        setLabel(importButton, 'Import plugins');
        importButton.hidden = true;
        mutationControls.add(importButton);
        ui.on(importButton, 'click', () => showImport());
        refreshButton = iconButton(listActions, 'refresh', 'Refresh plugins');
        ui.on(refreshButton, 'click', () => refreshPlugins(context));
        managementStatus = addText(settingsSection, 'div', 'codlet-status', '');
        managementStatus.setAttribute('role', 'status');
        managementStatus.setAttribute('aria-live', 'polite');
        pluginList = addText(settingsSection, 'div', 'codlet-plugin-list', '');
        clientStatusLine = addText(settingsSection, 'p', 'codlet-client-status', ''); clientStatusLine.hidden = true;
        createLocalPages(context, body);
        createUpdatePage(context, body);
        confirmation = addText(body, 'div', 'codlet-confirmation', '');
        confirmation.hidden = true;
        confirmation.setAttribute('role', 'group');
        setLabel(confirmation, 'Disable Codlet?');
        confirmationHeading = addText(confirmation, 'h2', 'codlet-section-title', '');
        confirmationCopy = addText(confirmation, 'p', 'codlet-confirmation-copy', '');
        confirmationCopy.id = `${panel.id}-disable-consequence`;
        removeSourceChoice = localCheckbox(confirmation, 'Delete source files', 'Delete the plugin source folder');
        removeSourceChoice.parentElement.hidden = true;
        confirmation.setAttribute('aria-describedby', confirmationCopy.id);
        confirmationStatus = addText(confirmation, 'div', 'codlet-status', '');
        confirmationStatus.setAttribute('role', 'status');
        confirmationStatus.hidden = true;
        const actions = addText(confirmation, 'div', 'codlet-confirmation-actions', '');
        cancelButton = addText(actions, 'button', '', 'Cancel');
        cancelButton.type = 'button';
        ui.on(cancelButton, 'click', cancelAction);
        confirmButton = addText(actions, 'button', 'codlet-confirm', 'Disable');
        confirmButton.type = 'button';
        ui.on(confirmButton, 'click', () => disableSelf(context));
        const currentPanel = panel;
        ui.on(panel, 'scroll', hideTooltip, true);
        ui.on(panel, 'pointerdown', event => {
            if (panel !== currentPanel || !panel.open || event.defaultPrevented) return;
            event.stopPropagation();
            if (event.target !== panel || event.button !== 0 || event.ctrlKey || event.isPrimary === false) return;
            const bounds = panel.getBoundingClientRect();
            if (event.clientX >= bounds.left && event.clientX <= bounds.right &&
                event.clientY >= bounds.top && event.clientY <= bounds.bottom) return;
            event.preventDefault();
            if (action === 'confirm' || action === 'failed') cancelAction();
            else setPanelOpen(false);
        });
        ui.on(panel, 'cancel', event => {
            if (event.defaultPrevented || panel !== currentPanel) return;
            event.preventDefault();
            event.stopPropagation();
            if (tooltip) { hideTooltip(); return; }
            if (action === 'confirm' || action === 'failed') cancelAction();
            else setPanelOpen(false);
        });
        ui.on(panel, 'close', () => {
            if (panel === currentPanel && !panel.open && !panel.hidden) setPanelOpen(false);
        });
        document.body.appendChild(panel);
    }

    function clearLocalBody(parent) {
        for (const child of Array.from(parent.children)) removeOwned(child);
    }

    function localInput(parent, label, multiline = false) {
        const field = addText(parent, 'div', 'codlet-field', '');
        const caption = addText(field, 'label', 'codlet-field-label', label);
        const input = ui.element(multiline ? 'textarea' : 'input');
        input.className = 'codlet-field-input';
        input.value = '';
        if (!multiline) input.type = 'text';
        setLabel(input, label);
        input.autocomplete = 'off'; input.spellcheck = false;
        input.id = `${panel.id}-field-${label.replace(/[^a-zA-Z0-9]/g, '-')}`;
        caption.setAttribute('for', input.id);
        field.appendChild(input);
        return input;
    }

    function localCheckbox(parent, label, text = label) {
        const row = addText(parent, 'label', 'codlet-permission-choice', '');
        const input = ui.element('input');
        input.type = 'checkbox'; input.checked = false;
        setLabel(input, label);
        row.appendChild(input);
        addText(row, 'span', '', text);
        return input;
    }

    function localStatus(message, error = null) {
        setText(importStatus, message); importStatus.hidden = !message;
        importErrorDetails.hidden = !error; importErrorDetails.open = false;
        setText(importErrorText, literal(error ?? ''));
    }

    function invalidatePreview() {
        localRequest += 1;
        if (previewTimer !== null) clearTimeout(previewTimer);
        previewTimer = null;
        if (pickerTimer !== null) clearTimeout(pickerTimer);
        pickerTimer = null;
        importPreview = null; importBusy = false;
        importGrants.clear(); scopeInputs.clear();
        importTrust = importEnable = null;
        clearLocalBody(previewBody);
        previewBody.hidden = true;
        importSubmit.disabled = true;
        chooseFolderButton.disabled = false;
    }

    function cancelGitHubWork() {
        if (githubTimer !== null) clearTimeout(githubTimer);
        githubTimer = null;
        const job = githubJob;
        githubJob = null;
        if (job?.jobId && runtimeContext) {
            void runtimeContext.rpc.request(RUNTIME_MANAGE_CAPABILITY, 'cancelGitHubJob', { jobId: job.jobId }).catch(() => {});
        }
        if (githubCancel) githubCancel.hidden = true;
        if (githubRetry) githubRetry.hidden = true;
    }

    function resetGitHubSelection() {
        cancelGitHubWork(); invalidatePreview();
        githubCatalog = null;
        fillSelect(githubRelease, 'Choose a release', []);
        fillSelect(githubAsset, 'Choose a ZIP asset', []);
        githubDownload.disabled = true;
        githubRead.disabled = false;
    }

    function configureImportPage() {
        const local = importMode === 'local';
        localFields.hidden = !local;
        chooseFolderButton.hidden = !local || localManagement?.folderPicker !== true;
        githubFields.hidden = local || importOperation === 'rollback';
        setText(importSubmit, local || importOperation === 'install' ? 'Import plugin' : importOperation === 'update' ? 'Update plugin' : 'Roll back plugin');
        setLabel(importSubmit, local ? 'Confirm local import' : importOperation === 'install' ? 'Confirm GitHub import' : importOperation === 'update' ? 'Confirm managed update' : 'Confirm managed rollback');
        localTab.setAttribute('aria-selected', String(local)); githubTab.setAttribute('aria-selected', String(!local));
        localTab.tabIndex = local ? 0 : -1; githubTab.tabIndex = local ? -1 : 0;
    }

    function showImport() {
        if (pendingOperation || action !== 'idle' || !panel?.open || panel.hidden) return;
        resetGitHubSelection(); importMode = 'local'; importOperation = 'install'; importTarget = null;
        page = 'import';
        configureImportPage();
        localStatus('');
        renderAction();
        focus(importPath);
        if (importPath.value.trim()) scheduleLocalPreview(runtimeContext);
    }

    function scheduleLocalPreview(context) {
        invalidatePreview();
        const value = importPath.value.trim();
        if (!value) { localStatus(''); return; }
        if (!/^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+|\/)/.test(value)) { localStatus('Enter the full path to a plugin folder.'); return; }
        localStatus('Checking the selected folder...');
        const epoch = lifecycle, request = localRequest;
        previewTimer = setTimeout(() => { previewTimer = null; if (epoch === lifecycle && request === localRequest) void inspectLocal(context); }, 400);
    }

    function backToPlugins(context) {
        if (pendingOperation) return;
        cancelUpdatePolling();
        updateBusy = false;
        resetGitHubSelection();
        page = 'plugins'; detailsPlugin = null;
        renderAction();
        focus(searchInput);
        return refreshPlugins(context);
    }

    function importReady() {
        importSubmit.disabled = !importPreview || importBusy || pendingOperation !== null
            || importTrust?.checked !== true || [...importGrants.values()].some(control => !control.checked);
    }

    function renderImportPreview(preview) {
        clearLocalBody(previewBody);
        importGrants.clear(); scopeInputs.clear();
        const manifest = preview.manifest;
        addText(previewBody, 'h2', 'codlet-section-title', literal(() => pluginName(manifest)));
        addText(previewBody, 'p', 'codlet-local-copy', literal(`${manifest.id} · ${manifest.version}`));
        const requirements = [
            ...(manifest.renderer ? (manifest.requires ?? []).map(cap => ({ ...cap, entry: 'Renderer' })) : []),
            ...(manifest.host ? (manifest.renderer ? manifest.host.requires ?? [] : manifest.requires ?? []).map(cap => ({ ...cap, entry: 'Host' })) : [])
        ];
        if (requirements.length) addText(previewBody, 'p', 'codlet-local-copy', `Dependencies\n${requirements.map(cap => `${cap.entry} dependency: ${cap.name}@${cap.api} (${cap.scope})`).join('\n')}`);
        const unavailable = (preview.dependencyCheck?.requirements ?? []).filter(requirement => requirement.status === 'unavailable');
        if (unavailable.length) addText(previewBody, 'p', 'codlet-local-copy', `Currently unavailable: ${unavailable.map(item => `${item.capability.name}@${item.capability.api}`).join(', ')}. You can import the folder while disabled, then enable its providers first.`);
        if (importMode === 'github') {
            renderManagedSource(previewBody, preview.source, preview.metadata);
            if (preview.currentVersion) {
                addText(previewBody, 'p', 'codlet-local-copy', `Version: ${preview.currentVersion.manifest.version} → ${manifest.version}\nRepository: ${preview.currentVersion.source.repositoryUrl} → ${preview.source.repositoryUrl}\nRelease: ${preview.currentVersion.source.tag} → ${preview.source.tag}`);
                const runtimeDeclaration = metadata => metadata?.runtimeApi == null ? 'unknown' : `author declared API ${metadata.runtimeApi}`;
                const platformDeclaration = metadata => metadata?.platforms?.length ? `author declared ${metadata.platforms.join(', ')}` : 'unknown';
                addText(previewBody, 'p', 'codlet-local-copy', `Runtime declaration: ${runtimeDeclaration(preview.currentVersion.metadata)} → ${runtimeDeclaration(preview.metadata)}\nPlatform declaration: ${platformDeclaration(preview.currentVersion.metadata)} → ${platformDeclaration(preview.metadata)}`);
                const changes = preview.changes ?? {};
                for (const [label, key] of [['Permissions added', 'permissionsAdded'], ['Permissions removed', 'permissionsRemoved'], ['Dependencies added', 'requirementsAdded'], ['Dependencies removed', 'requirementsRemoved']]) {
                    addText(previewBody, 'p', 'codlet-local-copy', `${label}: ${(changes[key] ?? []).map(item => typeof item === 'string' ? item : `${item.name}@${item.api} (${item.scope})`).join(', ') || 'None'}`);
                }
                addText(previewBody, 'p', 'codlet-local-copy', `Currently ${preview.existingEnabled ? 'enabled' : 'disabled'}. This ${importOperation} leaves the plugin disabled unless you select “Enable after import”. Confirm the source and every grant again.`);
            }
        }
        if (preview.existingRegistration && importMode === 'local') {
            addText(previewBody, 'p', 'codlet-local-copy', `Already registered at this folder. Confirm all grants again to replace its permission settings.\nCurrent grants: ${preview.existingRegistration.grants.join(', ') || 'None'}. Stop the package before importing it again.`);
        }
        addText(previewBody, 'h2', 'codlet-section-title', 'Requested permissions');
        for (const permission of manifest.permissions ?? []) {
            const checkbox = localCheckbox(previewBody, `Grant ${permission}`, `${permission} — ${PERMISSION_COPY[permission] || permission}`);
            importGrants.set(permission, checkbox);
            ui.on(checkbox, 'change', importReady);
        }
        if (!(manifest.permissions ?? []).length) addText(previewBody, 'p', 'codlet-local-copy', 'No permissions requested.');
        for (const [permission, key, label] of [
            ['host.fs', 'readRoots', 'Allowed read folders — one full path per line'],
            ['host.network', 'networkOrigins', 'Allowed network origins — one HTTP(S) origin per line'],
            ['host.process', 'executables', 'Allowed child programs — one full .exe path per line']
        ]) {
            if (importGrants.has(permission)) scopeInputs.set(key, localInput(previewBody, label, true));
        }
        if (scopeInputs.size) addText(previewBody, 'p', 'codlet-local-copy', 'Empty lists grant no access through the file, network or child-process broker. Native Host code still runs with your OS user permissions.');
        importTrust = localCheckbox(previewBody, importMode === 'local' ? 'Trust this local plugin' : 'Trust this GitHub source', importMode === 'local' ? 'I trust this plugin’s author and this local folder.' : `I trust the author and this exact source: ${preview.source.repositoryUrl}, release ${preview.source.tag}, asset ${preview.source.assetName}.`);
        importEnable = localCheckbox(previewBody, 'Enable after import', importMode === 'local' || importOperation === 'install' ? 'Enable immediately after importing' : `Enable after ${importOperation}; otherwise keep disabled`);
        ui.on(importTrust, 'change', importReady);
        previewBody.hidden = false;
        importReady();
    }

    async function inspectLocal(context) {
        if (pendingOperation || importBusy || page !== 'import' || !panel?.open || panel.hidden) return;
        invalidatePreview();
        const path = importPath.value.trim();
        if (!path) { localStatus('Enter the full path to a plugin folder.'); focus(importPath); return; }
        importBusy = true; chooseFolderButton.disabled = true;
        const request = localRequest, epoch = lifecycle;
        localStatus('Checking the manifest and JavaScript entries...');
        try {
            const preview = await context.rpc.request(RUNTIME_MANAGE_CAPABILITY, 'previewLocal', { path });
            if (epoch !== lifecycle || request !== localRequest || page !== 'import' || !panel?.open || panel.hidden) return;
            if (preview?.schema !== 1 || preview.kind !== 'codlet.local-import-preview' || typeof preview.path !== 'string'
                || typeof preview.manifest?.id !== 'string' || typeof preview.manifest?.version !== 'string'
                || !Array.isArray(preview.manifest.permissions) || preview.manifest.permissions.some(permission => !Object.hasOwn(PERMISSION_COPY, permission))
                || !/^[0-9a-f]{64}$/.test(preview.contentDigest) || !/^[0-9a-f]{64}$/.test(preview.registrationDigest)) throw new Error('The import preview is incomplete.');
            importPreview = preview; importBusy = false;
            renderImportPreview(preview);
            localStatus('Plugin recognized. Choose permissions to import.');
        } catch (error) {
            if (epoch === lifecycle && request === localRequest && page === 'import') localStatus('This folder could not be recognized as a plugin. Check the path and codlet.json.', String(error?.message ?? error));
        } finally {
            if (epoch === lifecycle && request === localRequest) {
                importBusy = false; chooseFolderButton.disabled = false; importReady();
            }
        }
    }

    async function chooseLocalFolder(context) {
        if (pendingOperation || importBusy || page !== 'import' || !panel?.open || panel.hidden) return;
        invalidatePreview(); importBusy = true;
        chooseFolderButton.disabled = true;
        const request = localRequest, epoch = lifecycle;
        const current = () => epoch === lifecycle && request === localRequest && page === 'import' && panel?.open && !panel.hidden;
        localStatus('Choose a plugin folder in the Windows dialog.');
        const accept = async selection => {
            if (!current()) return;
            if (selection?.status === 'selecting' && typeof selection.selectionId === 'string') {
                pickerTimer = setTimeout(async () => {
                    pickerTimer = null;
                    if (!current()) return;
                    try { await accept(await context.rpc.request(RUNTIME_MANAGE_CAPABILITY, 'folderSelection', { selectionId: selection.selectionId })); }
                    catch (error) { fail(error); }
                }, 300);
            } else if (selection?.status === 'selected' && typeof selection.path === 'string') {
                importPath.value = selection.path; importBusy = false;
                await inspectLocal(context);
            } else {
                importBusy = false; chooseFolderButton.disabled = false;
                localStatus(selection?.status === 'cancelled' ? 'Folder selection cancelled.' : selection?.error || 'Folder selection failed. Enter the full path instead.');
            }
        };
        const fail = error => {
            if (!current()) return;
            importBusy = false; chooseFolderButton.disabled = false;
            localStatus(String(error?.message ?? error));
        };
        try { await accept(await context.rpc.request(RUNTIME_MANAGE_CAPABILITY, 'chooseLocalFolder', { locale: context.i18n?.locale ?? 'en' })); }
        catch (error) { fail(error); }
    }

    function submitImport(context) {
        importReady();
        if (importSubmit.disabled || !importPreview || page !== 'import') return;
        const preview = importPreview;
        const brokerPolicy = Object.fromEntries([...scopeInputs].map(([key, input]) => [key, input.value.split(/\r?\n/).map(line => line.trim()).filter(Boolean)]));
        const selection = { path: preview.path, contentDigest: preview.contentDigest, registrationDigest: preview.registrationDigest,
            trusted: true, grants: [...importGrants].filter(([, input]) => input.checked).map(([permission]) => permission), brokerPolicy, enable: importEnable.checked,
            ...(importMode === 'github' ? { managed: importOperation } : {}) };
        const nextAction = importMode === 'github' && importOperation !== 'install' ? importOperation : 'import';
        cancelGitHubWork(); invalidatePreview(); page = 'plugins'; renderAction();
        return managePlugin(context, preview.manifest.id, nextAction, false, { local_import: selection }, preview.manifest.name || preview.manifest.id);
    }

    function renderManagedSource(parent, source, metadata) {
        addText(parent, 'p', 'codlet-local-copy', `Repository: ${source.repositoryUrl}\nRelease/tag: ${source.tag}\nAsset: ${source.assetName}\nSHA-256: ${source.sha256}\nGitHub digest: ${source.upstreamDigestVerified ? 'matched' : 'not available for verification'}`);
        addText(parent, 'p', 'codlet-local-copy', `Runtime compatibility: ${metadata?.runtimeApi === undefined || metadata.runtimeApi === null ? 'unknown (not declared)' : `author declared API ${metadata.runtimeApi}`}\nPlatforms: ${Array.isArray(metadata?.platforms) && metadata.platforms.length ? `author declared ${metadata.platforms.join(', ')}` : 'unknown (not declared)'}\nCodex builds tested: unknown; no verification claim is made by this importer.${metadata?.author ? `\nAuthor: ${metadata.author}` : ''}`);
    }

    function fillSelect(select, placeholder, options) {
        clearLocalBody(select);
        const blank = addText(select, 'option', '', placeholder); blank.value = '';
        for (const [value, label] of options) { const option = addText(select, 'option', '', label); option.value = String(value); }
        select.value = ''; select.disabled = options.length === 0;
    }

    function showGitHubImport(context, target = null) {
        if (pendingOperation || action !== 'idle' || !panel?.open || panel.hidden) return;
        resetGitHubSelection(); importMode = 'github'; importOperation = target ? 'update' : 'install'; importTarget = target;
        githubUrl.value = target?.managedSource?.repositoryUrl ?? '';
        page = 'import'; configureImportPage(); renderAction();
        localStatus(target ? 'Check releases, then explicitly choose a version and asset. Updating requires fresh source trust and grants.' : 'Enter a GitHub repository, release or release asset URL. Select a published ZIP package; repository source archives are not installable packages.');
        focus(githubUrl);
        if (target && githubUrl.value) return readGitHubReleases(context);
    }

    function githubControls() {
        githubRead.disabled = importBusy;
        githubRelease.disabled = importBusy || !githubCatalog?.releases.length;
        const release = githubCatalog?.releases.find(item => String(item.id) === githubRelease.value);
        githubAsset.disabled = importBusy || !release?.assets.some(asset => /\.zip$/i.test(asset.name));
        githubDownload.disabled = importBusy || !release || !release.assets.some(asset => String(asset.id) === githubAsset.value && /\.zip$/i.test(asset.name));
        githubCancel.hidden = !importBusy;
        importReady();
    }

    function acceptManagedPreview(preview, selection = null) {
        if (preview?.schema !== 1 || preview.kind !== 'codlet.managed-preview' || preview.operation !== importOperation
            || preview.ownership !== 'core-managed-github' || typeof preview.path !== 'string'
            || typeof preview.manifest?.id !== 'string' || typeof preview.manifest?.version !== 'string'
            || !Array.isArray(preview.manifest.permissions) || preview.manifest.permissions.some(permission => !Object.hasOwn(PERMISSION_COPY, permission))
            || !/^[0-9a-f]{64}$/.test(preview.contentDigest) || !/^[0-9a-f]{64}$/.test(preview.registrationDigest)
            || !/^[0-9a-f]{64}$/.test(preview.source?.sha256) || typeof preview.source.repositoryUrl !== 'string'
            || typeof preview.source.tag !== 'string' || typeof preview.source.assetName !== 'string'
            || (importTarget && preview.manifest.id !== importTarget.id)
            || (selection && (preview.source.repositoryUrl !== selection.repositoryUrl || preview.source.releaseId !== selection.releaseId || preview.source.assetId !== selection.assetId))) throw new Error('The managed package preview is incomplete or does not match the selected plugin and release asset.');
        importPreview = preview; importBusy = false;
        renderImportPreview(preview);
        localStatus('Review the exact source, compatibility, dependencies and permissions before confirming.');
        focus(importGrants.values().next().value ?? importTrust);
    }

    function acceptGitHubCatalog(catalog) {
        if (typeof catalog?.repository?.url !== 'string' || !Array.isArray(catalog.releases)
            || catalog.releases.some(release => !Number.isSafeInteger(release.id) || typeof release.tag !== 'string' || !Array.isArray(release.assets)
                || release.assets.some(asset => !Number.isSafeInteger(asset.id) || typeof asset.name !== 'string' || !Number.isSafeInteger(asset.size)))) throw new Error('The GitHub release list is incomplete.');
        githubCatalog = catalog;
        fillSelect(githubRelease, 'Choose a release', catalog.releases.map(release => [release.id, `${release.tag}${release.prerelease ? ' (prerelease)' : ''}${release.name ? ` — ${release.name}` : ''}`]));
        fillSelect(githubAsset, 'Choose a ZIP asset', []);
        localStatus(catalog.releases.length ? `Repository: ${catalog.repository.url}\nChoose the exact release and ZIP asset.${catalog.requestedTag ? `\nLink requests tag: ${catalog.requestedTag}${catalog.requestedAsset ? ` / ${catalog.requestedAsset}` : ''}. Confirm that selection below.` : ''}${catalog.truncated ? '\nOnly part of the release history is listed. Use an exact release URL for an older version.' : ''}` : 'No published releases found. Ask the author for a built plugin ZIP, or download and inspect a local plugin folder.');
    }

    async function runGitHubJob(context, method, params, kind) {
        if (pendingOperation || importBusy || page !== 'import' || importMode !== 'github' || !panel?.open || panel.hidden) return;
        invalidatePreview(); cancelGitHubWork();
        importBusy = true;
        const request = localRequest, epoch = lifecycle;
        const expected = { jobId: null, kind, request, epoch, checking: false, selection: kind === 'package' ? params : null };
        githubJob = expected; githubControls();
        localStatus(kind === 'releases' ? 'Reading GitHub releases...' : 'Downloading and validating the selected ZIP. No plugin is registered or enabled yet.');
        try {
            const reply = await context.rpc.request(RUNTIME_MANAGE_CAPABILITY, method, params);
            if (githubJob !== expected || epoch !== lifecycle || request !== localRequest) return;
            if (typeof reply?.jobId !== 'string' || !reply.jobId) throw new Error('GitHub task did not return a job ID. No installation was submitted.');
            expected.jobId = reply.jobId;
            await acceptGitHubJob(context, expected, reply);
        } catch (error) {
            if (githubJob === expected && epoch === lifecycle && request === localRequest) {
                githubJob = null; importBusy = false; githubControls(); localStatus(String(error?.message ?? error));
            }
        }
    }

    async function acceptGitHubJob(context, expected, reply) {
        if (githubJob !== expected || expected.epoch !== lifecycle || expected.request !== localRequest || page !== 'import' || !panel?.open || panel.hidden) return;
        if (reply?.jobId !== expected.jobId || reply.kind !== expected.kind) throw new Error('GitHub task response did not match the requested job.');
        if (reply.status === 'running') {
            localStatus(`${expected.kind === 'releases' ? 'Reading releases' : 'Preparing package'}${reply.stage ? `: ${reply.stage}` : '...'}\nNo installation has been submitted.`);
            githubTimer = setTimeout(() => { githubTimer = null; void pollGitHubJob(context, expected); }, 300);
            return;
        }
        if (reply.status === 'completed') {
            if (expected.kind === 'releases') acceptGitHubCatalog(reply.result);
            else acceptManagedPreview(reply.result, expected.selection);
        } else if (reply.status === 'cancelled') localStatus('GitHub task cancelled. No installation was submitted; temporary download files may remain.');
        else if (reply.status === 'failed') localStatus(reply.error?.message || 'GitHub task failed. No installation was submitted.');
        else throw new Error('GitHub task returned an unknown status.');
        githubJob = null; importBusy = false; githubRetry.hidden = true; githubControls();
    }

    async function pollGitHubJob(context, expected = githubJob) {
        if (!expected?.jobId || githubJob !== expected || expected.checking) return;
        expected.checking = true; githubRetry.hidden = true;
        try {
            const reply = await context.rpc.request(RUNTIME_MANAGE_CAPABILITY, 'githubJob', { jobId: expected.jobId });
            await acceptGitHubJob(context, expected, reply);
        } catch (error) {
            if (githubJob === expected && expected.epoch === lifecycle && expected.request === localRequest) {
                localStatus(`Task status unavailable: ${String(error?.message ?? error)}\nCheck the same task again, or cancel. No new download or installation is started by checking.`);
                githubRetry.hidden = false;
            }
        } finally { expected.checking = false; }
    }

    function readGitHubReleases(context) {
        if (importBusy) return;
        const url = githubUrl.value.trim();
        if (!url) { localStatus('Enter a GitHub URL.'); focus(githubUrl); return; }
        resetGitHubSelection();
        return runGitHubJob(context, 'githubReleases', { url }, 'releases');
    }

    function downloadGitHubAsset(context) {
        githubControls();
        if (githubDownload.disabled) return;
        return runGitHubJob(context, 'githubPrepare', { repositoryUrl: githubCatalog.repository.url, releaseId: Number(githubRelease.value), assetId: Number(githubAsset.value), operation: importOperation, ...(importTarget ? { pluginId: importTarget.id } : {}) }, 'package');
    }

    async function requestLocalAction(plugin, nextAction, permission, origin) {
        if (pendingOperation || action !== 'idle' || !panel?.open || panel.hidden) return;
        const dependents = (plugin.disableDependents ?? []).filter(id => id !== plugin.id);
        confirmationSelection = { id: plugin.id, name: pluginName(plugin), action: nextAction, permission, cascade: nextAction === 'remove' && dependents.length > 0 };
        const dependentNames = dependents.map(id => pluginName(visiblePlugins.find(candidate => candidate.id === id) ?? { id }));
        const copy = nextAction === 'remove'
            ? `Remove this plugin’s registration and disable it. Source files and plugin data are kept by default. Selecting deletion below removes the source folder and all its contents.${dependentNames.length ? `\nAlso disable: ${dependentNames.join(', ')}.` : ''}`
            : `Revoke ${permission}. This stops the package and its running dependents. To grant it again, ${plugin.ownership === 'core-managed-github' ? 'select a managed version and confirm its permissions again' : 'import the local folder and confirm its permissions'}.${dependentNames.length ? `\nDependents: ${dependentNames.join(', ')}.` : ''}`;
        setText(confirmationCopy, copy);
        removalPreview = null; removeSourceChoice.checked = false; removeSourceChoice.disabled = true;
        removeSourceChoice.parentElement.hidden = nextAction !== 'remove';
        removalBusy = nextAction === 'remove';
        const request = ++removalRequest, epoch = lifecycle;
        actionOrigin = origin; action = 'confirm'; renderAction(); focus(cancelButton);
        if (!removalBusy) return;
        setText(confirmationCopy, `${copy}\nChecking source folder...`);
        try {
            const preview = await runtimeContext.rpc.request(RUNTIME_MANAGE_CAPABILITY, 'sourceRemovalPreview', { pluginId: plugin.id });
            if (request !== removalRequest || epoch !== lifecycle || action !== 'confirm' || !panel?.open || panel.hidden) return;
            if (preview?.pluginId !== plugin.id || !['available', 'missing', 'blocked'].includes(preview.status)) throw new Error('The source folder could not be checked. You can still remove registration and keep files.');
            const deletable = preview.status === 'available' && /^[a-f0-9]{64}$/.test(preview.registrationDigest) && typeof preview.sourceIdentity === 'string' && !!preview.sourceIdentity;
            removalPreview = deletable ? preview : null; removeSourceChoice.disabled = !deletable;
            const notice = preview.status === 'missing' ? 'The source folder is missing or moved. Removing registration is still available.' : !deletable ? 'Source deletion is unavailable. Removing registration keeps the remaining files.' : `Source folder: ${preview.path}`;
            setText(confirmationCopy, `${copy}\n${notice}${preview.warning ? `\n${preview.warning}` : ''}`);
        } catch (error) {
            if (request === removalRequest && epoch === lifecycle && action === 'confirm') setText(confirmationCopy, `${copy}\nThe source folder could not be checked. You can still remove registration and keep files.\n${String(error?.message ?? error)}`);
        } finally { if (request === removalRequest && epoch === lifecycle && action === 'confirm') { removalBusy = false; renderAction(); } }
    }

    async function showDetails(context, plugin) {
        if (pendingOperation || action !== 'idle' || !panel?.open || panel.hidden) return;
        cancelGitHubWork(); invalidatePreview(); page = 'details'; detailsPlugin = plugin;
        const request = localRequest, epoch = lifecycle;
        clearLocalBody(detailsBody); setText(detailsStatus, 'Loading permissions...'); detailsStatus.hidden = false;
        renderAction();
        try {
            const bundled = plugin.source === 'bundled';
            const reply = bundled ? { pluginId: plugin.id, registration: { path: '', grants: plugin.grants ?? [] } } : await context.rpc.request(RUNTIME_MANAGE_CAPABILITY, 'permissions', { pluginId: plugin.id });
            if (epoch !== lifecycle || request !== localRequest || page !== 'details' || !panel?.open || panel.hidden) return;
            if (reply?.pluginId !== plugin.id || !Array.isArray(reply.registration?.grants) || typeof reply.registration.path !== 'string') throw new Error('Permission details are unavailable.');
            const registration = reply.registration;
            detailsPlugin = { ...plugin, path: registration.path, grants: registration.grants, ...(reply.ownership ? { ownership: reply.ownership } : {}), ...(reply.managedSource ? { managedSource: reply.managedSource } : {}) };
            const managed = detailsPlugin.ownership === 'core-managed-github';
            const heading = addText(detailsBody, 'div', 'codlet-details-heading', '');
            addText(heading, 'h2', 'codlet-section-title', literal(() => pluginName(plugin)));
            if (!bundled) {
                const folder = iconButton(heading, 'folder', 'Open plugin folder');
                ui.on(folder, 'click', async () => {
                    if (folder.disabled || pendingOperation) return;
                    folder.disabled = true;
                    try {
                        const opened = await context.rpc.request(RUNTIME_MANAGE_CAPABILITY, 'openFolder', { pluginId: plugin.id });
                        if (epoch !== lifecycle || request !== localRequest || page !== 'details') return;
                        if (opened?.pluginId !== plugin.id || opened.opened !== true) throw new Error('The source folder could not be opened.');
                    } catch (error) { if (epoch === lifecycle && request === localRequest && page === 'details') { setText(detailsStatus, `The source folder could not be opened.\n${String(error?.message ?? error)}`); detailsStatus.hidden = false; } }
                    finally { if (epoch === lifecycle && request === localRequest) folder.disabled = false; }
                });
            }
            addText(detailsBody, 'p', 'codlet-local-copy', literal(`${plugin.id}${plugin.version ? ` · ${plugin.version}` : ''}`));
            addText(detailsBody, 'p', 'codlet-local-copy', literal(() => pluginDescription(plugin)));
            addText(detailsBody, 'p', 'codlet-local-copy', bundled ? 'Bundled plugin' : managed ? 'Codlet managed GitHub package' : 'Local development folder');
            if (managed && detailsPlugin.managedSource) renderManagedSource(detailsBody, detailsPlugin.managedSource, reply.metadata);
            if (registration.grants.length) addText(detailsBody, 'h2', 'codlet-section-title', 'Granted permissions');
            for (const permission of registration.grants) {
                const row = addText(detailsBody, 'div', 'codlet-permission-line', '');
                addText(row, 'p', 'codlet-local-copy', `${permission}\n${PERMISSION_COPY[permission] || ''}`);
                if (!bundled) {
                    const revoke = addText(row, 'button', '', 'Revoke');
                    setLabel(revoke, `Revoke ${permission}`);
                    ui.on(revoke, 'click', () => requestLocalAction(detailsPlugin, 'revoke', permission, revoke));
                }
            }
            for (const [key, label] of [['readRoots', 'Allowed read folders'], ['networkOrigins', 'Allowed network origins'], ['executables', 'Allowed child programs']]) {
                const values = registration.brokerPolicy?.[key] ?? [];
                if (values.length) addText(detailsBody, 'p', 'codlet-local-copy', `${label}\n${values.join('\n')}`);
            }
            const remove = guiButton({ text: 'Remove plugin', label: `Remove ${pluginName(plugin)}`, variant: 'danger' });
            if (!bundled) { detailsBody.appendChild(remove); ui.on(remove, 'click', () => requestLocalAction(detailsPlugin, 'remove', null, remove)); }
            else removeOwned(remove);
            detailsStatus.hidden = true;
            if (managed) {
                const target = detailsPlugin;
                const check = addText(detailsBody, 'button', '', 'Check GitHub versions');
                setLabel(check, 'Check GitHub versions');
                ui.on(check, 'click', () => showGitHubImport(context, target));
                addText(detailsBody, 'h2', 'codlet-section-title', 'Installed version history');
                const historyBody = addText(detailsBody, 'div', 'codlet-local-preview', '');
                await showManagedHistory(context, target, historyBody, request, epoch);
            }
        } catch (error) {
            if (epoch === lifecycle && request === localRequest && page === 'details') setText(detailsStatus, String(error?.message ?? error));
        }
    }

    async function showManagedHistory(context, plugin, parent, request, epoch) {
        const current = () => epoch === lifecycle && request === localRequest && page === 'details' && detailsPlugin?.id === plugin.id && parent.isConnected && panel?.open && !panel.hidden;
        const status = addText(parent, 'p', 'codlet-local-copy', 'Loading retained versions...');
        const rows = addText(parent, 'div', 'codlet-local-preview', '');
        const more = addText(parent, 'button', '', 'Load more versions');
        setLabel(more, 'Load more versions'); more.hidden = true;
        let nextCursor = 0, currentVersion, busy = false;
        const seen = new Set();
        const load = async () => {
            if (!current() || busy || nextCursor === null) return;
            busy = true; more.disabled = true;
            const cursor = nextCursor;
            setText(status, seen.size ? 'Loading more retained versions...' : 'Loading retained versions...');
            try {
                const report = await context.rpc.request(RUNTIME_MANAGE_CAPABILITY, 'managedHistory', { pluginId: plugin.id, ...(cursor ? { cursor } : {}) });
                if (!current()) return;
                const following = report?.nextCursor ?? null;
                if (report?.pluginId !== plugin.id || !Array.isArray(report.history) || report.history.length > 8
                    || (report.currentVersion !== null && typeof report.currentVersion !== 'string')
                    || (following !== null && (!Number.isSafeInteger(following) || following <= cursor || !report.history.length))) throw new Error('Managed version history is unavailable or its cursor is invalid.');
                if (currentVersion !== undefined && report.currentVersion !== currentVersion) throw new Error('The installed version changed. Reopen details to refresh the history.');
                if (report.history.some(version => typeof version.versionKey !== 'string' || typeof version.manifest?.version !== 'string' || typeof version.source?.tag !== 'string')) throw new Error('Managed version history is incomplete.');
                currentVersion = report.currentVersion;
                for (const version of report.history) {
                    if (seen.has(version.versionKey)) continue;
                    seen.add(version.versionKey);
                    const row = addText(rows, 'div', 'codlet-field', '');
                    addText(row, 'p', 'codlet-local-copy', `${version.manifest.version} · ${version.source.tag}${currentVersion === version.versionKey ? ' · Current' : ''}\n${version.source.repositoryUrl}\n${version.source.assetName}\nSHA-256: ${version.source.sha256}`);
                    if (currentVersion !== version.versionKey) {
                        const rollback = addText(row, 'button', '', 'Review rollback');
                        setLabel(rollback, `Review rollback ${version.versionKey}`);
                        ui.on(rollback, 'click', () => inspectRollback(context, plugin, version.versionKey));
                    }
                }
                nextCursor = following;
                setText(status, seen.size ? 'Rollback uses an already retained package. Review its source and permissions again before applying.' : 'No retained versions.');
                more.hidden = nextCursor === null;
            } catch (error) {
                if (current()) { setText(status, String(error?.message ?? error)); more.hidden = false; }
            } finally {
                busy = false;
                if (current()) more.disabled = false;
            }
        };
        ui.on(more, 'click', load);
        await load();
    }

    async function inspectRollback(context, plugin, versionKey) {
        if (pendingOperation || action !== 'idle' || !panel?.open || panel.hidden) return;
        resetGitHubSelection(); importMode = 'github'; importOperation = 'rollback'; importTarget = plugin;
        page = 'import'; importBusy = true; configureImportPage(); renderAction();
        const request = localRequest, epoch = lifecycle;
        localStatus('Validating the retained package and comparing permissions...');
        try {
            const preview = await context.rpc.request(RUNTIME_MANAGE_CAPABILITY, 'previewRollback', { pluginId: plugin.id, versionKey });
            if (epoch !== lifecycle || request !== localRequest || page !== 'import' || !panel?.open || panel.hidden) return;
            acceptManagedPreview(preview);
        } catch (error) {
            if (epoch === lifecycle && request === localRequest && page === 'import') localStatus(String(error?.message ?? error));
        } finally { if (epoch === lifecycle && request === localRequest) { importBusy = false; importReady(); } }
    }

    function createLocalPages(context, parent) {
        importSection = addText(parent, 'section', 'codlet-local-page', '');
        importSection.hidden = true;
        backButton(importSection, context);
        const tabs = addText(importSection, 'div', 'codlet-source-tabs', ''); tabs.setAttribute('role', 'tablist');
        localTab = addText(tabs, 'button', '', 'Local folder'); localTab.setAttribute('role', 'tab'); setLabel(localTab, 'Local folder');
        githubTab = addText(tabs, 'button', '', 'GitHub'); githubTab.setAttribute('role', 'tab'); setLabel(githubTab, 'Import from GitHub');
        ui.on(localTab, 'click', () => { if (importMode !== 'local') showImport(); else focus(importPath); });
        ui.on(githubTab, 'click', () => { if (!githubTab.disabled) { if (importMode !== 'github') return showGitHubImport(context); focus(githubUrl); } });
        ui.on(tabs, 'keydown', event => {
            if (event.altKey || event.ctrlKey || event.metaKey || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            const choices = [localTab, githubTab].filter(tab => !tab.disabled), index = choices.indexOf(event.target);
            if (index < 0) return;
            event.preventDefault(); event.stopPropagation();
            const next = event.key === 'Home' ? choices[0] : event.key === 'End' ? choices[choices.length - 1] : choices[(index + (event.key === 'ArrowRight' ? 1 : choices.length - 1)) % choices.length];
            if (next === event.target) return;
            if (next === localTab) showImport(); else showGitHubImport(context);
            focus(next);
        });
        importPath = localInput(importSection, 'Plugin folder');
        localFields = importPath.parentElement;
        const pathRow = addText(localFields, 'div', 'codlet-folder-input', ''); pathRow.appendChild(importPath);
        chooseFolderButton = iconButton(pathRow, 'folder', 'Choose plugin folder');
        ui.on(chooseFolderButton, 'click', () => chooseLocalFolder(context));
        ui.on(importPath, 'input', () => scheduleLocalPreview(context));
        githubFields = addText(importSection, 'div', 'codlet-local-preview', ''); githubFields.hidden = true;
        githubUrl = localInput(githubFields, 'GitHub repository or release URL');
        ui.on(githubUrl, 'input', () => { resetGitHubSelection(); localStatus('Read releases for this source before downloading. Trust and grants have been cleared.'); });
        githubRead = addText(githubFields, 'button', '', 'Read releases');
        setLabel(githubRead, 'Read GitHub releases');
        ui.on(githubRead, 'click', () => readGitHubReleases(context));
        const select = label => {
            const field = addText(githubFields, 'label', 'codlet-field', '');
            addText(field, 'span', 'codlet-field-label', label);
            const control = ui.element('select'); control.className = 'codlet-field-input'; setLabel(control, label);
            field.appendChild(control); return control;
        };
        githubRelease = select('GitHub release'); fillSelect(githubRelease, 'Choose a release', []);
        githubAsset = select('GitHub ZIP asset'); fillSelect(githubAsset, 'Choose a ZIP asset', []);
        ui.on(githubRelease, 'change', () => {
            cancelGitHubWork(); invalidatePreview();
            const release = githubCatalog?.releases.find(item => String(item.id) === githubRelease.value);
            const assets = release?.assets.filter(asset => /\.zip$/i.test(asset.name)) ?? [];
            fillSelect(githubAsset, 'Choose a ZIP asset', assets.map(asset => [asset.id, `${asset.name} (${asset.size.toLocaleString()} bytes)`]));
            localStatus(release ? assets.length ? `Selected release: ${release.tag}. Choose the exact plugin ZIP asset.` : 'This release has no ZIP assets. Repository source archives are not plugin release packages. Ask the author for a built package or use local folder import.' : 'Choose an exact release.');
            githubControls();
        });
        ui.on(githubAsset, 'change', () => { cancelGitHubWork(); invalidatePreview(); githubControls(); localStatus('Download and validate this asset before granting permissions.'); });
        githubDownload = addText(githubFields, 'button', '', 'Download and inspect ZIP'); githubDownload.disabled = true;
        setLabel(githubDownload, 'Download selected GitHub asset');
        ui.on(githubDownload, 'click', () => downloadGitHubAsset(context));
        githubCancel = addText(githubFields, 'button', '', 'Cancel GitHub task'); githubCancel.hidden = true;
        setLabel(githubCancel, 'Cancel GitHub task');
        ui.on(githubCancel, 'click', () => {
            cancelGitHubWork(); invalidatePreview(); githubControls();
            localStatus('GitHub task cancelled. Late results will be ignored. No installation was submitted; temporary download files may remain.');
        });
        githubRetry = addText(githubFields, 'button', '', 'Check task status'); githubRetry.hidden = true;
        setLabel(githubRetry, 'Check GitHub task status');
        ui.on(githubRetry, 'click', () => pollGitHubJob(context));
        importStatus = addText(importSection, 'div', 'codlet-local-copy', '');
        importStatus.setAttribute('role', 'status'); importStatus.setAttribute('aria-live', 'polite');
        importErrorDetails = addText(importSection, 'details', 'codlet-import-error', ''); importErrorDetails.hidden = true;
        addText(importErrorDetails, 'summary', 'codlet-local-copy', 'Error details');
        importErrorText = addText(importErrorDetails, 'p', 'codlet-local-copy', '');
        previewBody = addText(importSection, 'div', 'codlet-local-preview', ''); previewBody.hidden = true;
        importSubmit = guiButton({ text: 'Import plugin', label: 'Confirm local import', variant: 'primary', disabled: true });
        importSection.appendChild(importSubmit);
        ui.on(importSubmit, 'click', () => submitImport(context));
        communityLink = ui.externalLink({ text: translate('Browse community plugins'), href: COMMUNITY_URL });
        communityLink.className = 'codlet-community-link'; setText(communityLink, 'Browse community plugins');
        communityLink.appendChild(ui.icon('external')); importSection.appendChild(communityLink);
        detailsSection = addText(parent, 'section', 'codlet-local-page', ''); detailsSection.hidden = true;
        backButton(detailsSection, context);
        detailsStatus = addText(detailsSection, 'div', 'codlet-local-copy', ''); detailsStatus.setAttribute('role', 'status');
        detailsBody = addText(detailsSection, 'div', 'codlet-local-preview', '');
    }

    function layoutPanel() {
        if (!panel) return;
        const mount = findMount();
        const anchor = mount?.parentElement ?? mount;
        panelAnchor = anchor;
        const top = Math.min(globalThis.innerHeight, Math.max(0, Math.round(anchor?.getBoundingClientRect().bottom ?? 40)));
        panel.style.top = `${top}px`;
        panel.style.setProperty('--codlet-available-top', `${top}px`);
    }

    function setPanelOpen(open) {
        if (!panel || (open ? panel.open && !panel.hidden : !panel.open && panel.hidden)) return false;
        if (open) {
            if (!panel.isConnected) return false;
            returnFocus = document.activeElement;
            panel.hidden = false;
            renderAction();
            layoutPanel();
            try {
                panel.showModal();
            } catch (error) {
                panel.hidden = true;
                if (panel.open) panel.close();
                button?.setAttribute('aria-expanded', 'false');
                if (button) button.title = error instanceof Error ? error.message : 'Could not open Codlet';
                if (panel.contains(document.activeElement)) focus(returnFocus);
                returnFocus = null;
                return false;
            }
            button?.setAttribute('aria-expanded', 'true');
            if (button) button.title = 'Codlet';
            focus(action === 'idle' && page === 'plugins' ? searchInput : closeButton);
        } else {
            hideTooltip();
            cancelUpdatePolling(); cancelHeaderPolling(); updateBusy = false; removalRequest += 1; removalBusy = false;
            cancelGitHubWork(); invalidatePreview(); page = 'plugins'; detailsPlugin = null;
            panelRequest += 1;
            if (operationTimer !== null) clearTimeout(operationTimer);
            operationTimer = null;
            const restore = panel.contains(document.activeElement);
            if (action === 'confirm' || action === 'failed') {
                action = 'idle';
                confirmationSelection = null;
                renderAction();
            }
            if (panel.open) panel.close();
            panel.hidden = true;
            button?.setAttribute('aria-expanded', 'false');
            if (restore) focus(returnFocus?.isConnected ? returnFocus : button?.isConnected ? button : outsideFocus);
            returnFocus = null;
        }
        return true;
    }

    function mountButton(context) {
        const mount = findMount();
        if (!mount) {
            setPanelOpen(false);
            return;
        }
        if (!button) {
            button = guiButton({ text: 'Codlet', label: 'Codlet', variant: 'menu' });
            button.setAttribute(BUTTON_ATTRIBUTE, 'codlet');
            setLabel(button, 'Codlet');
            button.setAttribute('aria-haspopup', 'dialog');
            button.setAttribute('aria-controls', panel.id);
            button.setAttribute('aria-expanded', 'false');
            ui.on(button, 'keydown', keydown);
            ui.on(button, 'click', () => {
                if (panel.hidden === false) return setPanelOpen(false);
                if (setPanelOpen(true)) return refreshPlugins(context);
            });
        }
        if (button.parentElement !== mount) mount.appendChild(button);
        layoutPanel();
    }

    async function start(context, epoch) {
        await waitForDocument();
        if (epoch !== lifecycle) return;
        let runtime, capability;
        try {
            runtime = await context.rpc.request(RUNTIME_PING_CAPABILITY, 'ping', null);
            if (epoch !== lifecycle || runtime?.pong !== true || runtime?.abi !== 1) return;
            capability = await context.rpc.request(MOUNT_CAPABILITY, 'getMount', null);
            if (epoch !== lifecycle) return;
            if (typeof capability?.available !== 'boolean' || capability.token !== CAPABILITY_TOKEN) throw new Error('Unsupported UI mount contract');
            const appearance = await context.rpc.request(APPEARANCE_CAPABILITY, 'describe', null);
            if (epoch !== lifecycle) return;
            if (context.ui?.api !== 1) throw new Error('Update the managed renderer runtime for UI helpers');
            ui = context.ui.create(appearance);
        } catch (error) {
            if (epoch === lifecycle) context.reportDiagnostic?.({ code: 'gui_ui_unavailable', message: String(error?.message ?? error) });
            return;
        }
        if (epoch !== lifecycle) return;
        mountToken = capability.token;
        runtimeContext = context;
        outsideFocus = document.activeElement;
        keydown = event => {
            if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || event.altKey ||
                event.ctrlKey || event.metaKey || event.shiftKey || panel.hidden || !isOwned(event.target)) return;
            event.preventDefault();
            event.stopPropagation();
            if (tooltip) { hideTooltip(); return; }
            if (action === 'confirm' || action === 'failed') cancelAction();
            else setPanelOpen(false);
        };
        installStyle();
        createPanel(context);
        stopLocale = context.i18n?.onChange?.(() => { if (epoch === lifecycle && panel) refreshLanguage(context); }) ?? null;
        ui.on(panel, 'keydown', keydown);
        mountButton(context);
        observer = new MutationObserver(() => {
            const mount = findMount();
            if (!button?.isConnected || button.parentElement !== mount) mountButton(context);
            else if (mount?.parentElement !== panelAnchor) layoutPanel();
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
        focusin = event => {
            if (!isOwned(event.target)) outsideFocus = event.target;
        };
        resize = () => { hideTooltip(); layoutPanel(); };
        document.addEventListener('focusin', focusin);
        globalThis.addEventListener('resize', resize);
    }

    function deactivate() {
        cancelGitHubWork();
        cancelUpdatePolling(); cancelHeaderPolling(); stopLocale?.(); stopLocale = null;
        if (previewTimer !== null) clearTimeout(previewTimer); previewTimer = null;
        removalRequest += 1; removalBusy = false; removalPreview = null;
        lifecycle += 1;
        panelRequest += 1;
        localRequest += 1;
        if (pickerTimer !== null) clearTimeout(pickerTimer);
        pickerTimer = null;
        importPreview = detailsPlugin = localManagement = null;
        importGrants.clear(); scopeInputs.clear();
        textBindings.clear();
        page = 'plugins'; importBusy = false;
        if (operationTimer !== null) clearTimeout(operationTimer);
        operationTimer = null;
        pendingOperation = null;
        managementBusy = false;
        hideTooltip();
        visiblePlugins = [];
        confirmationSelection = null;
        mutationControls.clear();
        renderedPlugins.clear();
        cancelDocumentWait?.();
        const restore = isOwned(document.activeElement);
        const target = returnFocus?.isConnected && !isOwned(returnFocus) ? returnFocus : outsideFocus;
        observer?.disconnect();
        panel?.removeEventListener('keydown', keydown);
        button?.removeEventListener('keydown', keydown);
        document.removeEventListener('focusin', focusin);
        globalThis.removeEventListener('resize', resize);
        if (panel?.open) panel.close();
        if (panel) panel.hidden = true;
        ui?.dispose(); ui = null;
        button?.remove();
        panel?.remove();
        style?.remove();
        if (restore) focus(target);
        style = button = panel = pluginList = managementStatus = refreshButton = closeButton = null;
        panelTitle = versionLabel = developmentLabel = clientStatusLine = settingsSection = searchInput = null;
        updateButton = updateSection = updateBody = updateStatus = updateReply = null; updateBusy = false;
        importButton = importSection = importPath = localFields = chooseFolderButton = importStatus = importErrorDetails = importErrorText = previewBody = importSubmit = null;
        localTab = githubTab = communityLink = confirmationHeading = removeSourceChoice = null;
        importTrust = importEnable = detailsSection = detailsBody = detailsStatus = null;
        githubButton = githubFields = githubUrl = githubRead = githubRelease = githubAsset = githubDownload = githubCancel = githubRetry = null;
        githubCatalog = importTarget = runtimeContext = null; importMode = 'local'; importOperation = 'install';
        confirmation = confirmationCopy = confirmationStatus = confirmButton = cancelButton = actionOrigin = null;
        observer = keydown = focusin = resize = mountToken = returnFocus = outsideFocus = panelAnchor = null;
        action = 'idle';
        actionError = '';
    }

    return {
        activate(context) {
            deactivate();
            context.onDeactivate(deactivate);
            return start(context, lifecycle);
        },
        deactivate
    };
})();
