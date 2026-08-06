import * as fs from 'fs';
import * as path from 'path';
import {
    WebviewView,
    WebviewViewProvider,
    WebviewViewResolveContext,
    CancellationToken,
    ExtensionContext,
    Uri,
    Webview,
    commands,
    env,
    workspace,
    window,
    Disposable
} from 'vscode';
import { PickList, getAllPets } from './PickList';
import { onDidChangeGlobalState } from './global';
import { getColorEntries } from './color';
import { ImageOverridesStore } from './imageOverrides';
import { isPathInside } from './rotation';

/**
 * Vue-powered single-pane configuration webview.
 *
 * Loads the inlined Vite build at `webview-dist/index.html`, injects a CSP
 * + nonce, and brokers messages between the extension host and the SPA.
 *
 * Inbound message shapes:
 *   { type: 'ready' }
 *   { type: 'runAction', action: number, path?: string }
 *   { type: 'setConfig', key: string, value: any }
 *   { type: 'setGlobalState', key: string, value: any }
 *   { type: 'applyDecorations', state: { ... } }
 *   { type: 'openExternal', url: string }
 *   { type: 'galleryMessage', command: 'set_img'|'set_home', data: any }
 *
 * Outbound:
 *   { type: 'state', data: { locale, config, state } }
 *   { type: 'navigate', tab: 'home'|'gallery'|'advanced'|'decoration' }
 */
export class StudioViewProvider implements WebviewViewProvider {

    public static readonly viewType = 'backgroundCover.studio';

    private view?: WebviewView;
    private disposables: Disposable[] = [];
    private galleryBusy = false;
    /** Set of allowed local-resource root directories (fs paths). */
    private allowedRoots = new Set<string>();

    constructor(private readonly ctx: ExtensionContext) {}

    public resolveWebviewView(
        view: WebviewView,
        _context: WebviewViewResolveContext,
        _token: CancellationToken
    ): void {
        this.view = view;
        this.seedAllowedRoots();
        view.webview.options = {
            enableScripts: true,
            localResourceRoots: this.computeRootUris()
        };
        view.webview.html = this.getHtml(view.webview);

        view.webview.onDidReceiveMessage((msg: any) => this.handleMessage(msg), undefined, this.disposables);


        // Push state on config / globalState changes

        
        this.disposables.push(workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('backgroundCover')) { this.pushState(); }
        }));
        this.disposables.push(onDidChangeGlobalState.event(() => this.pushState()));

        view.onDidDispose(() => {
            this.disposables.forEach(d => d.dispose());
            this.disposables = [];
            this.view = undefined;
        });
    }

    /** Re-send full state; used by external commands (refresh/home/support). */
    public pushState(): void {
        void this.sendState();
    }

    private async sendState(): Promise<void> {
        if (!this.view) { return; }
        const cfg = workspace.getConfiguration('backgroundCover');
        const gs = this.ctx.globalState;

        const imagePath = cfg.get<string>('imagePath') || '';
        const imagePathDisplay = this.toWebviewUri(imagePath);

        const recentRaw = gs.get<string[]>('backgroundCoverRecentImages', []) || [];
        const recentImages = recentRaw.map(p => ({
            path: p,
            display: this.toWebviewUri(p),
            name: this.basename(p)
        }));

        const folder = cfg.get<string>('randomImageFolder') || '';
        let folderImages: { path: string; display: string; name: string }[] = [];
        let folderImagesTotal = 0;
        try {
            if (folder && fs.existsSync(folder) && fs.statSync(folder).isDirectory()) {
                const names = PickList.listFolderImages(folder);
                folderImagesTotal = names.length;
                folderImages = names.slice(0, 2000).map(name => {
                    const full = path.join(folder, name);
                    return { path: full, display: this.toWebviewUri(full), name };
                });
            }
        } catch {
            folderImages = [];
            folderImagesTotal = 0;
        }

        const petRoot = Uri.joinPath(this.ctx.extensionUri, 'resources', 'pet');
        const pets = getAllPets().map(p => {
            const thumbUri = p.source === 'codex' && p.spritesheetPath
                ? Uri.file(p.spritesheetPath)
                : Uri.joinPath(petRoot, p.folder, p.idle);
            let thumb = '';
            try { thumb = this.view!.webview.asWebviewUri(thumbUri).toString(); } catch { thumb = ''; }
            return { value: p.value, label: p.label, desc: p.desc, thumb };
        });

        const colorPalette = getColorEntries();

        let brandLogo = '';
        try {
            const logoUri = Uri.joinPath(this.ctx.extensionUri, 'resources', 'background-cover.png');
            brandLogo = this.view.webview.asWebviewUri(logoUri).toString();
        } catch { brandLogo = ''; }
        const pkg = (this.ctx.extension && (this.ctx.extension as any).packageJSON) || {};
        const brandName: string = pkg.displayName || pkg.name || 'background-cover';

        let imageConfigs: { name: string; display: string; weight: number; dwellBonusSeconds: number; minDisplaySeconds: number }[] = [];
        if (folder && fs.existsSync(folder) && fs.statSync(folder).isDirectory()) {
            try {
                const overrides = await new ImageOverridesStore(folder).load();
                imageConfigs = overrides.map(o => ({
                    name: o.file,
                    display: this.toWebviewUri(path.join(folder, o.file)),
                    weight: o.weight,
                    dwellBonusSeconds: o.dwellBonusSeconds,
                    minDisplaySeconds: o.minDisplaySeconds
                }));
            } catch {
                imageConfigs = [];
            }
        }

        this.view.webview.postMessage({
            type: 'state',
            data: {
                locale: (gs.get<string>('backgroundCoverLocale') as 'en' | 'zh' | undefined)
                    ?? (env.language.startsWith('zh') ? 'zh' : 'en'),
                brandLogo,
                brandName,
                config: {
                    opacity: cfg.get('opacity') ?? 0.2,
                    blur: cfg.get('blur') ?? 0,
                    imagePath,
                    imagePathDisplay,
                    autoStatus: cfg.get('autoStatus') ?? false,
                    autoInterval: cfg.get('autoInterval') ?? 10,
                    autoIntervalUnit: cfg.get('autoIntervalUnit') ?? 'seconds',
                    playMode: cfg.get('playMode') ?? 'random',
                    triggerMode: cfg.get('triggerMode') ?? 'timer',
                    antiSticky: cfg.get('antiSticky') ?? true,
                    antiStickyLevel: cfg.get('antiStickyLevel') ?? 2,
                    sizeModel: cfg.get('sizeModel') ?? 'cover',
                    blendModel: cfg.get('blendModel') ?? 'auto',
                    randomImageFolder: cfg.get('randomImageFolder') ?? ''
                },
                state: {
                    petEnabled: gs.get('backgroundCoverPetEnabled') ?? false,
                    petType: gs.get('backgroundCoverPetType') ?? '',
                    petMessages: gs.get('backgroundCoverPetMessages') ?? '',
                    particleEffect: gs.get('backgroundCoverParticleEffect') ?? false,
                    particleColor: gs.get('backgroundCoverParticleColor') ?? '#ffffff',
                    particleCount: gs.get('backgroundCoverParticleCount') ?? 60,
                    particleOpacity: gs.get('backgroundCoverParticleOpacity') ?? 0.5,
                    recentImages,
                    folderImages,
                    folderImagesTotal,
                    pets,
                    colorPalette,
                    imageConfigs
                }
            }
        });
    }

    /** Programmatic navigation hook for `view/title` menu commands. */
    public navigate(tab: 'home' | 'gallery' | 'advanced' | 'decoration'): void {
        this.view?.webview.postMessage({ type: 'navigate', tab });
    }

    /** Refresh the current Studio data without switching to the legacy gallery view. */
    public refresh(): void {
        this.pushState();
    }

    private async handleMessage(msg: any): Promise<void> {
        if (!msg || typeof msg.type !== 'string') { return; }
        switch (msg.type) {
            case 'ready':
                this.pushState();
                return;

            case 'runAction':
                if (typeof msg.action === 'number') {
                    await commands.executeCommand('backgroundCover.runAction', msg.action, msg.path);
                    this.pushState();
                }
                return;

            case 'setConfig':
                if (typeof msg.key === 'string') {
                    await commands.executeCommand('backgroundCover.setConfig', `backgroundCover.${msg.key}`, msg.value);
                }
                return;

            case 'setGlobalState':
                if (typeof msg.key === 'string') {
                    await this.ctx.globalState.update(msg.key, msg.value);
                    onDidChangeGlobalState.fire();
                }
                return;

            case 'pickImageForConfig':
                await this.pickImageForConfig();
                return;

            case 'saveImageConfig':
                await this.saveImageConfig(msg);
                return;

            case 'removeImageConfig':
                await this.removeImageConfig(msg);
                return;

            case 'applyDecorations':
                await this.applyDecorations(msg.state || {});
                return;

            case 'openExternal':
                if (typeof msg.url === 'string') {
                    await env.openExternal(Uri.parse(msg.url));
                }
                return;

            case 'galleryMessage':
                // Forwarded from the embedded online gallery iframe
                if (this.galleryBusy) { return; }
                this.galleryBusy = true;
                try {
                    const data = msg.data || {};
                    if (msg.command === 'set_img') {
                        if (data.link) {
                            await this.ctx.globalState.update('backgroundCoverOnlineDefault', data.link);
                        }
                        await PickList.updateImgPath(data.url);
                    } else if (msg.command === 'set_home') {
                        await this.ctx.globalState.update('backgroundCoverOnlineDefault', data.url);
                        await PickList.updateImgPath(data.url);
                        window.showInformationMessage('配置帖子图库成功，记得开启自动更换功能噢！/ Set successfully, remember to turn on the auto-change function!');
                    }
                } finally {
                    this.galleryBusy = false;
                }
                return;
        }
    }

    /** Native file picker for adding a per-image rotation config entry. */
    private async pickImageForConfig(): Promise<void> {
        const cfg = workspace.getConfiguration('backgroundCover');
        const folder = cfg.get<string>('randomImageFolder') || '';
        if (!folder || !fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
            window.showWarningMessage('Please set the source folder first / 请先设置来源目录');
            return;
        }
        const uris = await window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            defaultUri: Uri.file(folder),
            filters: { 'Images / Videos': ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'jfif', 'mp4', 'webm', 'ogg', 'mov'] },
            title: 'Select an image to configure / 选择要配置的图片'
        });
        if (!uris || uris.length === 0) { return; }
        const selected = uris[0].fsPath;
        if (!isPathInside(folder, selected)) {
            window.showWarningMessage('The selected file must be inside the source folder / 所选文件必须在来源目录内');
            return;
        }
        this.view?.webview.postMessage({ type: 'imageConfigPick', name: path.basename(selected), display: this.toWebviewUri(selected) });
    }

    /** Persist one image's weight / dwell bonus / min display time. */
    private async saveImageConfig(msg: any): Promise<void> {
        const cfg = workspace.getConfiguration('backgroundCover');
        const folder = cfg.get<string>('randomImageFolder') || '';
        if (!folder) { return; }
        const name = typeof msg.name === 'string' ? path.basename(msg.name) : '';
        if (!name) { return; }
        try {
            await new ImageOverridesStore(folder).save({
                file: name,
                weight: sanitizeNumber(msg.weight, 1, 0, 100),
                dwellBonusSeconds: sanitizeNumber(msg.dwellBonusSeconds, 0, -86400, 86400),
                minDisplaySeconds: sanitizeNumber(msg.minDisplaySeconds, 0, 0, 86400)
            });
        } catch (e: any) {
            window.showErrorMessage(`Failed to save image config / 保存图片配置失败: ${e?.message ?? e}`);
            return;
        }
        this.pushState();
    }

    /** Remove one image's rotation config entry. */
    private async removeImageConfig(msg: any): Promise<void> {
        const cfg = workspace.getConfiguration('backgroundCover');
        const folder = cfg.get<string>('randomImageFolder') || '';
        if (!folder) { return; }
        const name = typeof msg.name === 'string' ? path.basename(msg.name) : '';
        if (!name) { return; }
        try {
            await new ImageOverridesStore(folder).remove(name);
        } catch (e: any) {
            window.showErrorMessage(`Failed to remove image config / 删除图片配置失败: ${e?.message ?? e}`);
            return;
        }
        this.pushState();
    }

    private async applyDecorations(state: any): Promise<void> {
        const allowedKeys = [
            'backgroundCoverPetEnabled',
            'backgroundCoverPetType',
            'backgroundCoverPetMessages',
            'backgroundCoverParticleEffect',
            'backgroundCoverParticleColor',
            'backgroundCoverParticleCount',
            'backgroundCoverParticleOpacity'
        ];
        for (const key of allowedKeys) {
            if (Object.prototype.hasOwnProperty.call(state, key)) {
                await this.ctx.globalState.update(key, state[key]);
            }
        }
        onDidChangeGlobalState.fire();
        await PickList.applyCurrentBackground();
        await commands.executeCommand('workbench.action.reloadWindow');
    }

    /** Convert a local file path to a webview-safe URI. Returns empty for URLs. */
    private toWebviewUri(p: string): string {
        if (!p) { return ''; }
        if (/^https?:\/\//i.test(p)) { return p; }
        try {
            if (!fs.existsSync(p)) { return ''; }
            this.ensureRootForFile(p);
            return this.view!.webview.asWebviewUri(Uri.file(p)).toString();
        } catch {
            return '';
        }
    }

    private basename(p: string): string {
        return path.basename(p || '');
    }

    /** Seed initial allowed roots: extension dist, workspace folders, global/extension storage. */
    private seedAllowedRoots(): void {
        const add = (p: string | undefined) => {
            if (p) { this.allowedRoots.add(path.normalize(p)); }
        };
        add(Uri.joinPath(this.ctx.extensionUri, 'webview-dist').fsPath);
        add(Uri.joinPath(this.ctx.extensionUri, 'resources').fsPath);
        add(path.join(process.env.CODEX_HOME || path.join(process.env.HOME || '', '.codex'), 'pets'));
        add(this.ctx.globalStorageUri?.fsPath);
        add(this.ctx.storageUri?.fsPath);
        (workspace.workspaceFolders || []).forEach(f => add(f.uri.fsPath));
    }

    /** Register the directory containing the given file path as a localResourceRoot. */
    private ensureRootForFile(filePath: string): void {
        const dir = path.normalize(path.dirname(filePath));
        if (!dir || this.isCovered(dir)) { return; }
        this.allowedRoots.add(dir);
        if (this.view) {
            this.view.webview.options = {
                enableScripts: true,
                localResourceRoots: this.computeRootUris()
            };
        }
    }

    /** Check whether `dir` is already inside any registered root. */
    private isCovered(dir: string): boolean {
        const target = dir.toLowerCase();
        for (const root of this.allowedRoots) {
            const r = root.toLowerCase();
            if (target === r || target.startsWith(r + path.sep)) { return true; }
        }
        return false;
    }

    private computeRootUris(): Uri[] {
        return Array.from(this.allowedRoots).map(p => Uri.file(p));
    }

    private getHtml(webview: Webview): string {
        const indexFile = path.join(this.ctx.extensionPath, 'webview-dist', 'index.html');
        let html = '';
        try {
            html = fs.readFileSync(indexFile, 'utf8');
        } catch {
            return this.fallbackHtml('webview-dist/index.html not found. Run `npm run build:webview`.');
        }

        const nonce = randomNonce();
        const csp = [
            `default-src 'none'`,
            `img-src ${webview.cspSource} https: data: blob:`,
            `media-src ${webview.cspSource} https: data: blob:`,
            `style-src ${webview.cspSource} 'unsafe-inline'`,
            `font-src ${webview.cspSource} data:`,
            `script-src 'nonce-${nonce}'`,
            `frame-src https:`
        ].join('; ');

        // Inject CSP meta if missing
        if (!/Content-Security-Policy/i.test(html)) {
            html = html.replace(/<head[^>]*>/i, m => `${m}\n<meta http-equiv="Content-Security-Policy" content="${csp}">`);
        }

        // Stamp nonce on every inline/external script
        html = html.replace(/<script(?![^>]*\bnonce=)/gi, `<script nonce="${nonce}"`);

        return html;
    }

    private fallbackHtml(msg: string): string {
        return `<!doctype html><html><body style="font-family:sans-serif;padding:16px;color:#ccc;background:#1e1e1e">
            <h3>Background Cover Studio</h3>
            <p>${msg}</p>
        </body></html>`;
    }
}

/** Clamp an incoming number from the webview. */
function sanitizeNumber(value: unknown, fallback: number, min: number, max: number): number {
    const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
    return Math.min(max, Math.max(min, n));
}

function randomNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let out = '';
    for (let i = 0; i < 32; i++) { out += chars.charAt(Math.floor(Math.random() * chars.length)); }
    return out;
}
