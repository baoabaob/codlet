export const PERMISSION_COPY = Object.freeze({
        'ui.dom': 'Read and change the page interface', 'ui.mainWorld': 'Run in the page’s main JavaScript world',
        'cdp.raw': 'Use raw browser debugging access', 'host.process': 'Run native code with your user account’s OS permissions',
        'host.fs': 'Read files inside explicitly allowed folders', 'host.network': 'Request explicitly allowed HTTP(S) origins',
        'host.system': 'Read basic system information', 'runtime.manage': 'Manage other plugins and their permissions'
    });

export function createMessages(context) {
    const TRANSLATIONS = {
        'Plugin state could not be refreshed. Displayed values may be out of date.': '插件状态刷新失败，当前显示的值可能已过期。',
        'Search releases': '搜索发布版本', 'No matching releases': '没有匹配的发布版本',
        'Search assets': '搜索资源包', 'No matching assets': '没有匹配的资源包', 'bytes': '字节',
        'The update changed. Cancel and review it again before installing.': '待安装的更新已变化，请取消并重新查看后再安装。',
        'Clear search': '清除搜索', 'Version and compatibility': '版本与兼容性', 'Import source': '导入来源', 'Confirm action': '确认操作',
        'Client compatibility information is unavailable.': '暂时无法获取客户端兼容性信息。',
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
        'Find versions': '查找版本', 'GitHub repository or release URL': 'GitHub 仓库或发布链接',
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
        const locale = context?.i18n?.locale === 'zh' ? 'zh' : 'en';
        if (locale === 'en' || !text) return text;
        if (text.includes('\n')) return text.split('\n').map(translate).join('\n');
        let key = Object.hasOwn(TRANSLATIONS, text) ? text : null, values = {};
        if (!key) for (const template of templates) {
            const match = template.regex.exec(text);
            if (match) { key = template.key; values = Object.fromEntries(template.names.map((name, index) => [name, match[index + 1]])); break; }
        }
        if (!key) return text.includes('\n') ? text.split('\n').map(translate).join('\n') : text;
        for (const name of ['description', 'compatibility', 'platforms', 'status', 'state', 'operation', 'before', 'after', 'permissions', 'capabilities', 'stage']) if (Object.hasOwn(values, name)) values[name] = translate(values[name]);
        return context?.i18n?.t ? context.i18n.t(messages, key, values) : TRANSLATIONS[key].replace(/\{(\w+)\}/g, (_, name) => values[name] ?? `{${name}}`);
    }

return { t: translate, name: p => p.i18n?.[context.i18n?.locale === "zh" ? "zh" : "en"]?.name || p.name || p.id, description: p => p.i18n?.[context.i18n?.locale === "zh" ? "zh" : "en"]?.description || p.description || "" };
}
