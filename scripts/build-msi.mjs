import {readFile,writeFile,mkdir,stat} from 'node:fs/promises';
import {resolve,dirname,basename} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const [input,wix,output]=process.argv.slice(2);
if(!input||!wix||!output)throw Error('Usage: node scripts/build-msi.mjs PORTABLE_DIRECTORY WIX_DIRECTORY OUTPUT.msi');
const root=resolve(input),out=resolve(output),build=out+'.build';await mkdir(build,{recursive:true});
const compiler=spawnSync('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',resolve(import.meta.dirname,'Build-WindowsLauncher.ps1'),'-OutputDirectory',build,'-InstallerAssets'],{stdio:'inherit',windowsHide:true});
if(compiler.error||compiler.status!==0)throw Error('Windows installer helper compilation failed');
const manifest=JSON.parse(await readFile(resolve(root,'distribution-manifest.json'),'utf8'));
if(manifest.platform!=='win-x64'||manifest.kind!=='codlet-portable-distribution')throw Error('Expected Windows x64 portable input');
if(!/^[0-9a-f]{40}$/i.test(manifest.sourceCommit??'')||!/^[0-9a-f]{40}$/i.test(manifest.pluginsCommit??''))throw Error('Portable manifest must record full 40-hex Core and plugin commits');
const xml=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const digest=value=>createHash('sha256').update(value).digest('hex');
const id=(prefix,value)=>prefix+digest(value).slice(0,24);
const guid=value=>{const h=digest('codlet-preview-msi-v1:'+value);return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;};
const features={Core:[],UiAdapter:[],DesktopAdapter:[],GUI:[],StartMenu:[],DesktopShortcut:[]},directories=new Map([['','INSTALLFOLDER']]),components=[];
const payload=manifest.files.filter(file=>file.path!=='portable.mode').map(file=>({...file,source:resolve(root,file.path)}));
for(const name of ['msi-install.json','distribution-manifest.json']){
  const content=name==='msi-install.json'
    ?{schema:1,kind:'codlet-msi-install',version:manifest.version,coreUpgrade:'Use the next MSI; portable ZIP replacement is disabled'}
    :{...manifest,kind:'codlet-msi-distribution',files:payload.map(({source,...file})=>file)};
  const bytes=Buffer.from(JSON.stringify(content,null,2)+'\n'),source=resolve(build,name);await writeFile(source,bytes);payload.push({path:name,bytes:bytes.length,sha256:digest(bytes),source});
}
function directory(path){
  if(directories.has(path))return directories.get(path);
  const parent=path.includes('/')?path.slice(0,path.lastIndexOf('/')):'';
  directory(parent);const value=id('D_',path);directories.set(path,value);return value;
}
for(const file of payload){
  if(file.path.includes('..')||file.path.startsWith('/')||file.path.includes('\\')||file.path.includes(':'))throw Error('Unsafe payload path');
  const bytes=await readFile(file.source);if(bytes.length!==file.bytes||digest(bytes)!==file.sha256)throw Error('Portable manifest mismatch: '+file.path);
  const parent=file.path.includes('/')?file.path.slice(0,file.path.lastIndexOf('/')):'';
  const component=id('C_',file.path),fileId=id('F_',file.path),dir=directory(parent);
  components.push(`<DirectoryRef Id="${dir}"><Component Id="${component}" Guid="${guid(file.path)}" Win64="yes"><File Id="${fileId}" Name="${xml(basename(file.path))}" Source="${xml(file.source)}"/><RegistryValue Root="HKCU" Key="Software\\Codlet\\Preview\\Installer" Name="${component}" Type="integer" Value="1" KeyPath="yes"/></Component></DirectoryRef>`);
  const group=file.path.startsWith('optional-plugins/packages/codex.ui.adapter/')?'UiAdapter':file.path.startsWith('optional-plugins/packages/codex.desktop.adapter/')?'DesktopAdapter':file.path.startsWith('optional-plugins/packages/codlet-gui/')?'GUI':'Core';
  features[group].push(component);
}
function tree(path){let children='';for(const [relative,value]of directories){if(!relative)continue;const parent=relative.includes('/')?relative.slice(0,relative.lastIndexOf('/')):'';if(parent===path)children+=`<Directory Id="${value}" Name="${xml(basename(relative))}">${tree(relative)}</Directory>`;}return children;}
const refs=names=>names.map(name=>`<ComponentRef Id="${name}"/>`).join('');
components.push(`<DirectoryRef Id="INSTALLFOLDER"><Component Id="DirectoryCleanup" Guid="${guid('directory-cleanup')}" Win64="yes">${[...directories.values(),'ProgramsFolder'].map(dir=>`<RemoveFolder Id="${id('R_',dir)}" Directory="${dir}" On="uninstall"/>`).join('')}<RegistryValue Root="HKCU" Key="Software\\Codlet\\Preview\\Installer" Name="DirectoryCleanup" Type="integer" Value="1" KeyPath="yes"/></Component></DirectoryRef>`);
features.Core.push('DirectoryCleanup');
components.push(`<DirectoryRef Id="INSTALLFOLDER"><Component Id="InstallLocation" Guid="${guid('install-location')}" Win64="yes"><RegistryValue Root="HKCU" Key="Software\\Codlet\\Preview\\Installer" Name="InstallFolder" Type="string" Value="[INSTALLFOLDER]" KeyPath="yes"/></Component></DirectoryRef>`);
features.Core.push('InstallLocation');
const app=manifest.version,parts=/^(\d+)\.(\d+)\.(\d+)-preview\.(\d+)$/.exec(app);
if(!parts)throw Error('This builder accepts an explicit preview version only');
const msiVersion=`${parts[1]}.${parts[2]}.${Number(parts[4])}`;
if(Number(parts[4])>65535)throw Error('Preview sequence exceeds MSI version range');
const licenseText=await readFile(resolve(root,'LICENSE'),'utf8');
const rtfText=value=>value.replaceAll('\\','\\\\').replaceAll('{','\\{').replaceAll('}','\\}').replaceAll('\r','').replaceAll('\n','\\par\n');
const license='{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Segoe UI;}}\\f0\\fs20 '+rtfText('Codlet local Preview\n\nCore and official plugins are licensed under Apache-2.0. Installation is per-user. Optional plugins are initialized on first launch; uninstall preserves user data. See NOTICE for attribution and THIRD_PARTY_NOTICES.txt and the Node LICENSE for third-party terms.\n\n')+rtfText(licenseText)+'}';
await writeFile(resolve(build,'notice.rtf'),license);
const source=`<?xml version="1.0" encoding="utf-8"?>
<Wix xmlns="http://schemas.microsoft.com/wix/2006/wi"><Product Id="*" Name="Codlet Preview ${xml(app)}" Manufacturer="Codlet" Language="2052" Codepage="936" Version="${msiVersion}" UpgradeCode="941c0f18-d41f-46e9-a3d1-a9562d75bf76">
<Package InstallerVersion="500" Compressed="yes" InstallScope="perUser" InstallPrivileges="limited" Platform="x64" SummaryCodepage="936" Description="Codlet 本地测试版"/>
<Condition Message="此安装包仅支持当前用户安装">NOT ALLUSERS</Condition>
<Property Id="INSTALLFOLDER" Secure="yes"><RegistrySearch Id="PriorInstallFolder" Root="HKCU" Key="Software\\Codlet\\Preview\\Installer" Name="InstallFolder" Type="raw" Win64="yes"/></Property>
<Property Id="MSIRESTARTMANAGERCONTROL" Value="DisableShutdown"/>
<Binary Id="CodletInstallerActions" SourceFile="${xml(resolve(build,'Codlet-Installer-Preflight.exe'))}"/>
<CustomAction Id="CheckRunningApplications" BinaryKey="CodletInstallerActions" ExeCommand="&quot;[INSTALLFOLDER].&quot; [UILevel] &quot;[TempFolder]Codlet-Installer-[ProductCode].log&quot;" Execute="immediate" Return="check"/>
<InstallExecuteSequence><Custom Action="CheckRunningApplications" Before="InstallValidate">NOT UPGRADINGPRODUCTCODE</Custom></InstallExecuteSequence>
<MajorUpgrade AllowSameVersionUpgrades="yes" DowngradeErrorMessage="已安装更新版本的 Codlet Preview"/>
<MediaTemplate EmbedCab="yes" CompressionLevel="medium"/>
<Property Id="ARPPRODUCTICON" Value="CodletIcon"/><Property Id="ARPURLINFOABOUT" Value="https://github.com/baoabaob/codlet"/><Property Id="WIXUI_EXITDIALOGOPTIONALTEXT" Value="首次启动会准备所选插件。卸载保留插件、配置和用户数据。"/>
<Property Id="WIXUI_EXITDIALOGOPTIONALCHECKBOXTEXT" Value="立即启动 Codlet"/>
<CustomAction Id="LaunchCodletAfterInstall" FileKey="${id('F_','Codlet-Launcher.exe')}" ExeCommand="" Return="asyncNoWait" Impersonate="yes"/>
<Icon Id="CodletIcon" SourceFile="${xml(resolve(root,'codlet.ico'))}"/>
<Directory Id="TARGETDIR" Name="SourceDir"><Directory Id="LocalAppDataFolder"><Directory Id="ProgramsFolder" Name="Programs"><Directory Id="INSTALLFOLDER" Name="Codlet Preview">${tree('')}</Directory></Directory></Directory><Directory Id="ProgramMenuFolder"><Directory Id="CodletMenu" Name="Codlet Preview"/></Directory><Directory Id="DesktopFolder"/></Directory>
${components.join('\n')}
<DirectoryRef Id="CodletMenu"><Component Id="StartMenu" Guid="${guid('start-menu')}" Win64="yes"><Shortcut Id="LaunchCodlet" Name="Codlet Preview" Target="[INSTALLFOLDER]Codlet-Launcher.exe" WorkingDirectory="INSTALLFOLDER" Icon="CodletIcon"/><Shortcut Id="ChoosePlugins" Name="选择 Codlet 官方插件" Target="[INSTALLFOLDER]Codlet-Launcher.exe" Arguments="--configure" WorkingDirectory="INSTALLFOLDER" Icon="CodletIcon"/><RemoveFolder Id="RemoveMenu" On="uninstall"/><RegistryValue Root="HKCU" Key="Software\\Codlet\\Preview\\Installer" Name="Shortcuts" Type="integer" Value="1" KeyPath="yes"/></Component></DirectoryRef>
<DirectoryRef Id="DesktopFolder"><Component Id="DesktopShortcut" Guid="${guid('desktop-shortcut')}" Win64="yes"><Shortcut Id="DesktopCodlet" Name="Codlet Preview" Target="[INSTALLFOLDER]Codlet-Launcher.exe" WorkingDirectory="INSTALLFOLDER" Icon="CodletIcon"/><RegistryValue Root="HKCU" Key="Software\\Codlet\\Preview\\Installer" Name="DesktopShortcut" Type="integer" Value="1" KeyPath="yes"/></Component></DirectoryRef>
<Feature Id="Core" Title="Codlet Core（必需）" Description="运行时、CLI 与 codlet 技能。仅当前用户安装；不会修改官方客户端的数据目录。" Level="1" Absent="disallow" ConfigurableDirectory="INSTALLFOLDER">${refs(features.Core)}</Feature>
<Feature Id="StartMenu" Title="开始菜单快捷方式" Description="添加 Codlet 启动与插件选择入口。" Level="1"><ComponentRef Id="StartMenu"/></Feature>
<Feature Id="DesktopShortcut" Title="桌面快捷方式" Description="在当前用户桌面添加 Codlet 入口。" Level="2"><ComponentRef Id="DesktopShortcut"/></Feature>
<Feature Id="UiAdapter" Title="UI Adapter" Description="接入 Codex 侧栏和插件页面。需要界面访问权限。" Level="1">${refs(features.UiAdapter)}</Feature>
<Feature Id="DesktopAdapter" Title="Desktop Adapter" Description="提供客户端、对话和流量接入接口。需要主界面访问权限。" Level="1">${refs(features.DesktopAdapter)}</Feature>
<Feature Id="GUI" Title="Codlet GUI（包含 UI Adapter）" Description="图形化插件管理。自动包含 UI Adapter；需要插件管理与界面访问权限。" Level="1">${refs([...features.GUI,...features.UiAdapter])}</Feature>
<UIRef Id="WixUI_FeatureTree"/><WixVariable Id="WixUILicenseRtf" Value="${xml(resolve(build,'notice.rtf'))}"/>
<WixVariable Id="WixUIBannerBmp" Value="${xml(resolve(build,'banner.bmp'))}"/><WixVariable Id="WixUIDialogBmp" Value="${xml(resolve(build,'dialog.bmp'))}"/>
<UI>
<Error Id="1722">未继续安装：运行中应用的检查已取消或失败。请保存任务并退出相关应用后重试。诊断文件位于临时目录中的 Codlet-Installer-*.log。[2]</Error>
<Publish Dialog="ExitDialog" Control="Finish" Event="DoAction" Value="LaunchCodletAfterInstall" Order="1">WIXUI_EXITDIALOGOPTIONALCHECKBOX = 1 AND NOT Installed</Publish></UI>
</Product></Wix>`;
await writeFile(resolve(build,'Product.wxs'),source);
function run(program,args){const result=spawnSync(resolve(wix,program),args,{stdio:'inherit',windowsHide:true});if(result.error)throw result.error;if(result.status!==0)throw Error(`${program} exited ${result.status}`);}
run('candle.exe',['-nologo','-arch','x64','-out',resolve(build,'Product.wixobj'),resolve(build,'Product.wxs')]);
run('light.exe',['-nologo','-ext',resolve(wix,'WixUIExtension.dll'),'-cultures:zh-cn','-out',out,resolve(build,'Product.wixobj')]);
const bytes=await readFile(out);const result={path:out,version:app,msiVersion,bytes:bytes.length,sha256:digest(bytes),features:Object.keys(features),signed:false};await writeFile(out+'.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
