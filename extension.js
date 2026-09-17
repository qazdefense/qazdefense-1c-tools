const vscode = require('vscode');
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ============================================================================
// Часть 1: запуск задач 1С (Предприятие/Конфигуратор/деплой) — как было.
// ============================================================================

const TASKS = [
	{ label: 'Запустить Предприятие', task: '1С: Запустить Предприятие', icon: 'play', script: 'open-enterprise.ps1', args: [] },
	{ label: 'Открыть Конфигуратор', task: '1С: Открыть Конфигуратор', icon: 'tools', script: 'open-designer.ps1', args: [] },
	{ label: 'Загрузить изменённые объекты', task: '1С: Загрузить изменённые объекты', icon: 'cloud-upload', script: 'deploy-to-ib.ps1', args: [] },
	{ label: 'Загрузить + обновить БД', task: '1С: Загрузить изменённые объекты + обновить БД', icon: 'sync', script: 'deploy-to-ib.ps1', args: ['-UpdateDb'] },
	{ label: 'Обновить конфигурацию БД', task: '1С: Обновить конфигурацию БД', icon: 'database', script: 'update-db.ps1', args: [] },
];

// Состояние строки по имени задачи: 'running' | 'success' | 'error' | не задано (idle).
// Дерево перерисовывается через onDidChangeTreeData при каждом изменении, поэтому
// цвет/иконка строки — единственный видимый признак хода выполнения, не привязанный
// к тому, смотрит ли пользователь в этот момент на уведомление.
const taskState = new Map();
let taskTreeProvider;

function iconForTask(entry) {
	const status = taskState.get(entry.task);
	if (status === 'running') return new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('charts.yellow'));
	if (status === 'success') return new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green'));
	if (status === 'error') return new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
	return new vscode.ThemeIcon(entry.icon);
}

function descriptionForTask(entry) {
	const status = taskState.get(entry.task);
	if (status === 'running') return 'выполняется...';
	if (status === 'success') return 'готово';
	if (status === 'error') return 'ошибка';
	return undefined;
}

function setTaskState(entry, status) {
	if (status === undefined) taskState.delete(entry.task);
	else taskState.set(entry.task, status);
	if (taskTreeProvider) taskTreeProvider.refresh();
}

class TaskItem extends vscode.TreeItem {
	constructor(entry) {
		super(entry.label, vscode.TreeItemCollapsibleState.None);
		this.iconPath = iconForTask(entry);
		this.description = descriptionForTask(entry);
		this.command = { command: 'oneCLauncher.runTask', title: entry.label, arguments: [entry] };
		this.tooltip = `Задача VS Code: "${entry.task}"`;
	}
}

class TaskTreeProvider {
	constructor() {
		this._onDidChangeTreeData = new vscode.EventEmitter();
		this.onDidChangeTreeData = this._onDidChangeTreeData.event;
	}
	refresh() { this._onDidChangeTreeData.fire(); }
	getTreeItem(element) { return element; }
	getChildren() { return TASKS.map((entry) => new TaskItem(entry)); }
}

function getWorkspaceRoot() {
	const folders = vscode.workspace.workspaceFolders;
	return folders && folders.length > 0 ? folders[0].uri.fsPath : undefined;
}

function runPowerShell(scriptPath, args, cwd) {
	return new Promise((resolve, reject) => {
		cp.execFile(
			'powershell.exe',
			['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args],
			{ cwd, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
			(err, stdout, stderr) => {
				if (err) reject(new Error((stderr || '').trim() || err.message));
				else resolve(stdout);
			}
		);
	});
}

// Обратная связь прямо в строке дерева (иконка/цвет/подпись меняются, пока задача
// выполняется, и на несколько секунд после — успех/ошибка), плюс нотификация с
// прогрессом и статус-бар — тройное дублирование сигнала, чтобы не потерять клик.
async function runTaskWithFeedback(entry) {
	vscode.window.setStatusBarMessage(`$(sync~spin) ${entry.label}...`, 5000);
	setTaskState(entry, 'running');

	const tasks = await vscode.tasks.fetchTasks();
	const target = tasks.find((t) => t.name === entry.task);
	if (!target) {
		// Раньше без .vscode/tasks.json с ровно такими именами задач клик
		// по строке в дереве просто падал с ошибкой "задача не найдена" —
		// расширение требовало от пользователя вручную завести tasks.json
		// под магические строки (сравнение с whiterabbit.1c-dev-tools:
		// у них аналогичные команды запуска работают без внешнего
		// tasks.json вообще). Фолбэк ниже запускает тот же .1С/*.ps1
		// скрипт напрямую через runPowerShell — tasks.json остаётся
		// опциональным удобством (свой цвет/иконка в стандартной панели
		// "Задачи"), а не обязательным условием для работы кнопки.
		await runScriptWithFeedback(entry);
		return;
	}

	await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: entry.label, cancellable: false },
		() =>
			new Promise((resolve) => {
				const disposable = vscode.tasks.onDidEndTaskProcess((e) => {
					if (e.execution.task === target) {
						disposable.dispose();
						if (e.exitCode === 0 || e.exitCode === undefined) {
							setTaskState(entry, 'success');
							vscode.window.setStatusBarMessage(`$(check) ${entry.label} — готово`, 5000);
						} else {
							setTaskState(entry, 'error');
							vscode.window.showWarningMessage(`${entry.label}: завершилось с кодом ${e.exitCode}`);
						}
						setTimeout(() => setTaskState(entry, undefined), 4000);
						resolve();
					}
				});
				vscode.tasks.executeTask(target);
			})
	);
}

// Фолбэк-путь runTaskWithFeedback, когда в воркспейсе нет .vscode/tasks.json
// с нужной задачей: тот же .1С/<script>.ps1 напрямую через runPowerShell,
// та же обратная связь (строка дерева/статус-бар/прогресс), что и у пути
// через vscode.tasks.
async function runScriptWithFeedback(entry) {
	const root = getWorkspaceRoot();
	if (!root) {
		setTaskState(entry, 'error');
		vscode.window.showErrorMessage('Нет открытого воркспейса.');
		setTimeout(() => setTaskState(entry, undefined), 4000);
		return;
	}
	const scriptPath = path.join(root, '.1С', entry.script);
	if (!fs.existsSync(scriptPath)) {
		setTaskState(entry, 'error');
		vscode.window.showErrorMessage(`Скрипт не найден: .1С/${entry.script}`);
		setTimeout(() => setTaskState(entry, undefined), 4000);
		return;
	}
	try {
		await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: entry.label, cancellable: false },
			() => runPowerShell(scriptPath, entry.args, root)
		);
		setTaskState(entry, 'success');
		vscode.window.setStatusBarMessage(`$(check) ${entry.label} — готово`, 5000);
	} catch (e) {
		setTaskState(entry, 'error');
		vscode.window.showErrorMessage(`${entry.label}: ${e.message}`);
	}
	setTimeout(() => setTaskState(entry, undefined), 4000);
}

// ============================================================================
// Часть 2: базы 1С — список профилей (.1С/base-profiles/*.psd1) и переключение.
// ============================================================================

let basesTreeProvider;

class BaseItem extends vscode.TreeItem {
	constructor(profile) {
		super(profile.name, vscode.TreeItemCollapsibleState.None);
		this.iconPath = new vscode.ThemeIcon(profile.active ? 'circle-filled' : 'circle-outline',
			profile.active ? new vscode.ThemeColor('charts.green') : undefined);
		this.description = profile.config_base || '(Болванка)';
		this.tooltip = `${profile.target || profile.error || ''}`.trim() || undefined;
		this.contextValue = 'base-profile';
		this.profileName = profile.name;
		this.isActiveProfile = !!profile.active;
		this.command = { command: 'oneCLauncher.switchBase', title: 'Переключить базу', arguments: [profile.name] };
	}
}

class BasesTreeProvider {
	constructor() {
		this._onDidChangeTreeData = new vscode.EventEmitter();
		this.onDidChangeTreeData = this._onDidChangeTreeData.event;
	}
	refresh() { this._onDidChangeTreeData.fire(); }
	getTreeItem(element) { return element; }
	async getChildren() {
		const root = getWorkspaceRoot();
		if (!root) return [];
		try {
			const stdout = await runPowerShell(path.join(root, '.1С', 'switch-base.ps1'), ['-List', '-Json'], root);
			const data = JSON.parse(stdout);
			const profiles = data.profiles || [];
			if (profiles.length === 0) {
				const item = new vscode.TreeItem('Профилей не найдено — .1С/base-profiles/*.psd1');
				item.iconPath = new vscode.ThemeIcon('info');
				return [item];
			}
			return profiles.map((p) => new BaseItem(p));
		} catch (e) {
			const item = new vscode.TreeItem(`Ошибка чтения профилей: ${e.message}`);
			item.iconPath = new vscode.ThemeIcon('error');
			return [item];
		}
	}
}

async function switchBaseCommand(profileName) {
	const root = getWorkspaceRoot();
	if (!root) {
		vscode.window.showErrorMessage('Нет открытого воркспейса.');
		return;
	}
	const scriptPath = path.join(root, '.1С', 'switch-base.ps1');

	let picked = profileName;
	if (!picked) {
		let stdout;
		try {
			stdout = await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: 'Читаю список баз 1С...' },
				() => runPowerShell(scriptPath, ['-List', '-Json'], root)
			);
		} catch (e) {
			vscode.window.showErrorMessage(`Не удалось получить список баз: ${e.message}`);
			return;
		}
		let data;
		try {
			data = JSON.parse(stdout);
		} catch (e) {
			vscode.window.showErrorMessage('Не удалось разобрать список баз (некорректный JSON от switch-base.ps1).');
			return;
		}
		const profiles = data.profiles || [];
		if (profiles.length === 0) {
			vscode.window.showInformationMessage(
				'Профилей баз не найдено. Скопируйте .1С/config.example.psd1 в .1С/base-profiles/<Имя>.psd1.'
			);
			return;
		}
		const items = profiles.map((p) => ({
			label: (p.active ? '$(check) ' : '') + p.name,
			description: p.config_base || '',
			detail: p.target || p.error || '',
			profileName: p.name,
		}));
		const choice = await vscode.window.showQuickPick(items, { placeHolder: 'Выберите базу 1С для быстрого запуска' });
		if (!choice) return;
		picked = choice.profileName;
	}

	try {
		await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: `Переключение на "${picked}"...` },
			() => runPowerShell(scriptPath, ['-Name', picked, '-Json'], root)
		);
		vscode.window.showInformationMessage(`Активная база 1С: ${picked}`);
	} catch (e) {
		vscode.window.showErrorMessage(`Не удалось переключить базу: ${e.message}`);
		return;
	}
	if (basesTreeProvider) basesTreeProvider.refresh();
	if (metadataTreeProvider) metadataTreeProvider.refresh();
	updateProjectViewTitles();
}

// ----------------------------------------------------------------------------
// Редактирование/добавление профиля базы (.1С/base-profiles/<Имя>.psd1).
//
// Формат — PowerShell Data File (см. .1С/config.example.psd1). Полноценного
// парсера/сериализатора PSD1 здесь нет и не нужен: набор полей фиксирован и
// известен заранее, поэтому чтение — точечные регулярки по известным блокам
// (File/Server/Auth), а запись — генерация файла с нуля по шаблону. Из-за
// этого при сохранении файл перезаписывается начисто: ручные комментарии в
// нём (если кто-то дописал) не переживут редактирование через это меню —
// честно предупреждаем в сообщении после сохранения, а не молчим об этом.
// ----------------------------------------------------------------------------

function psd1Path(root, name) {
	return path.join(root, '.1С', 'base-profiles', `${name}.psd1`);
}

function psd1BlockField(text, blockName, fieldName) {
	const blockMatch = text.match(new RegExp(`${blockName}\\s*=\\s*@\\{([\\s\\S]*?)\\}`));
	if (!blockMatch) return '';
	const fieldMatch = blockMatch[1].match(new RegExp(`${fieldName}\\s*=\\s*"([^"]*)"`));
	return fieldMatch ? fieldMatch[1] : '';
}

function readBaseProfileFile(filePath) {
	const empty = { configBase: '', connectionType: 'File', filePath: '', server: '', ref: '', platformPath: '', user: '', password: '' };
	if (!fs.existsSync(filePath)) return empty;
	const text = fs.readFileSync(filePath, 'utf8');
	const top = (field) => {
		const m = text.match(new RegExp(`(?:^|[\\r\\n])\\s*${field}\\s*=\\s*"([^"]*)"`));
		return m ? m[1] : '';
	};
	return {
		configBase: top('ConfigBase'),
		connectionType: top('ConnectionType') || 'File',
		filePath: psd1BlockField(text, 'File', 'Path'),
		server: psd1BlockField(text, 'Server', 'Server'),
		ref: psd1BlockField(text, 'Server', 'Ref'),
		platformPath: top('PlatformPath'),
		user: psd1BlockField(text, 'Auth', 'User'),
		password: psd1BlockField(text, 'Auth', 'Password'),
	};
}

function psd1Escape(value) {
	return String(value || '').replace(/"/g, '""');
}

function buildPsd1(v) {
	const e = psd1Escape;
	return [
		'@{',
		`    ConfigBase = "${e(v.configBase)}"`,
		`    ConnectionType = "${e(v.connectionType)}"`,
		'',
		'    File = @{',
		`        Path = "${e(v.filePath)}"`,
		'    }',
		'',
		'    Server = @{',
		`        Server = "${e(v.server)}"`,
		`        Ref = "${e(v.ref)}"`,
		'    }',
		'',
		`    PlatformPath = "${e(v.platformPath)}"`,
		'',
		'    Auth = @{',
		`        User = "${e(v.user)}"`,
		`        Password = "${e(v.password)}"`,
		'    }',
		'}',
		'',
	].join('\r\n');
}

// Редактор профиля — панель (webview), а не цепочка showInputBox/showQuickPick:
// те у VS Code всегда рисуются одним и тем же плавающим окном сверху-по-центру
// (это ограничение платформы, из API не настраивается) и с формой в 8 полей
// это неудобно — жаловались, что "сверху неудобно". Тут все поля видно сразу,
// плюс кнопки "Обзор..." зовут обычный vscode.window.showOpenDialog.
let profileEditorPanel;

function profileEditorHtml(mode, name, initial) {
	const e = escapeHtml;
	const isServer = initial.connectionType === 'Server';
	return `<!doctype html><html><head><meta charset="utf-8">
<style>
	body { font-family: var(--vscode-font-family, sans-serif); color: var(--vscode-foreground);
		background: var(--vscode-editor-background); padding: 16px 20px 24px; }
	h2 { font-weight: 600; font-size: 14px; margin: 0 0 16px; }
	.row { margin-bottom: 12px; }
	label { display: block; font-size: 12px; opacity: .8; margin-bottom: 4px; }
	.hint { font-size: 11px; opacity: .6; margin-top: 3px; }
	input[type=text], input[type=password] {
		width: 100%; box-sizing: border-box; padding: 5px 7px; font-family: inherit; font-size: 13px;
		background: var(--vscode-input-background); color: var(--vscode-input-foreground);
		border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px;
	}
	.pathrow { display: flex; gap: 6px; }
	.pathrow input { flex: 1; }
	button { padding: 5px 12px; font-size: 13px; border: 1px solid var(--vscode-button-border, transparent);
		border-radius: 2px; cursor: pointer; background: var(--vscode-button-secondaryBackground);
		color: var(--vscode-button-secondaryForeground); }
	button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
	button:hover { background: var(--vscode-button-secondaryHoverBackground); }
	button.primary:hover { background: var(--vscode-button-hoverBackground); }
	.conntype { display: flex; gap: 14px; }
	.conntype label { display: flex; align-items: center; gap: 5px; font-size: 13px; opacity: 1; margin: 0; }
	.actions { margin-top: 18px; display: flex; gap: 8px; }
	.err { color: var(--vscode-errorForeground); font-size: 12px; min-height: 16px; margin-top: 8px; }
	fieldset { border: 1px solid var(--vscode-widget-border, #444); border-radius: 3px; margin: 0 0 14px; padding: 10px 12px 4px; }
	legend { font-size: 11px; opacity: .7; padding: 0 4px; }
</style></head>
<body>
<h2>${mode === 'add' ? 'Новая база 1С' : `Настройки базы «${e(name)}»`}</h2>
<form id="f">
	${mode === 'add' ? `<div class="row">
		<label for="name">Имя базы (имя файла профиля)</label>
		<input type="text" id="name" value="" placeholder="например, MyBase">
		<div class="hint">Латиница, цифры, точка, дефис, подчёркивание — без пробелов.</div>
	</div>` : ''}
	<div class="row">
		<label for="configBase">ConfigBase — папка в Configurations/&lt;Имя&gt;</label>
		<input type="text" id="configBase" value="${e(initial.configBase)}" placeholder="Болванка">
		<div class="hint">Пусто = Болванка.</div>
	</div>
	<fieldset>
		<legend>Подключение к информационной базе</legend>
		<div class="row conntype">
			<label><input type="radio" name="connectionType" value="File" ${isServer ? '' : 'checked'}> Файловая (File)</label>
			<label><input type="radio" name="connectionType" value="Server" ${isServer ? 'checked' : ''}> Серверная (Server)</label>
		</div>
		<div class="row" id="fileRow">
			<label for="filePath">Папка файловой ИБ (где лежит 1Cv8.1CD)</label>
			<div class="pathrow">
				<input type="text" id="filePath" value="${e(initial.filePath)}" placeholder="D:\\BASES\\...">
				<button type="button" id="browseFile">Обзор...</button>
			</div>
		</div>
		<div class="row" id="serverRow" style="display:none">
			<label for="server">Сервер (адрес или адрес:порт)</label>
			<input type="text" id="server" value="${e(initial.server)}" placeholder="server1c">
			<label for="ref" style="margin-top:8px">Имя базы на сервере</label>
			<input type="text" id="ref" value="${e(initial.ref)}">
		</div>
	</fieldset>
	<div class="row">
		<label for="platformPath">Путь к 1cv8.exe</label>
		<div class="pathrow">
			<input type="text" id="platformPath" value="${e(initial.platformPath)}" placeholder="C:\\Program Files\\1cv8\\...\\bin\\1cv8.exe">
			<button type="button" id="browsePlatform">Обзор...</button>
		</div>
	</div>
	<fieldset>
		<legend>Авторизация (пусто — без пароля)</legend>
		<div class="row">
			<label for="user">Логин</label>
			<input type="text" id="user" value="${e(initial.user)}">
		</div>
		<div class="row">
			<label for="password">Пароль</label>
			<input type="password" id="password" value="${e(initial.password)}">
		</div>
	</fieldset>
	<div class="actions">
		<button type="submit" class="primary">Сохранить</button>
		<button type="button" id="cancel">Отмена</button>
	</div>
	<div class="err" id="err"></div>
</form>
<script>
	const vscode = acquireVsCodeApi();
	const $ = (id) => document.getElementById(id);
	function syncConnType() {
		const isServer = document.querySelector('input[name=connectionType]:checked').value === 'Server';
		$('fileRow').style.display = isServer ? 'none' : 'block';
		$('serverRow').style.display = isServer ? 'block' : 'none';
	}
	document.querySelectorAll('input[name=connectionType]').forEach((r) => r.addEventListener('change', syncConnType));
	syncConnType();
	$('browseFile').addEventListener('click', () => vscode.postMessage({ type: 'browseFolder', target: 'filePath', current: $('filePath').value }));
	$('browsePlatform').addEventListener('click', () => vscode.postMessage({ type: 'browseFile', target: 'platformPath', current: $('platformPath').value }));
	$('cancel').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
	document.getElementById('f').addEventListener('submit', (ev) => {
		ev.preventDefault();
		vscode.postMessage({
			type: 'save',
			name: ${mode === 'add' ? "$('name').value.trim()" : JSON.stringify(name)},
			values: {
				configBase: $('configBase').value,
				connectionType: document.querySelector('input[name=connectionType]:checked').value,
				filePath: $('filePath').value,
				server: $('server').value,
				ref: $('ref').value,
				platformPath: $('platformPath').value,
				user: $('user').value,
				password: $('password').value,
			},
		});
	});
	window.addEventListener('message', (ev) => {
		const msg = ev.data;
		if (msg.type === 'pathPicked') $(msg.target).value = msg.value;
		if (msg.type === 'error') $('err').textContent = msg.text;
	});
</script>
</body></html>`;
}

function openProfileEditorPanel(mode, name, initial, onSave) {
	if (profileEditorPanel) profileEditorPanel.dispose();
	const panel = vscode.window.createWebviewPanel(
		'oneCLauncherProfileEditor',
		mode === 'add' ? 'Новая база 1С' : `База: ${name}`,
		vscode.ViewColumn.One,
		{ enableScripts: true, retainContextWhenHidden: false }
	);
	profileEditorPanel = panel;
	panel.onDidDispose(() => { if (profileEditorPanel === panel) profileEditorPanel = undefined; });
	panel.webview.html = profileEditorHtml(mode, name, initial);
	panel.webview.onDidReceiveMessage(async (msg) => {
		if (msg.type === 'cancel') {
			panel.dispose();
			return;
		}
		if (msg.type === 'browseFolder' || msg.type === 'browseFile') {
			const opts = { canSelectMany: false, openLabel: 'Выбрать' };
			if (msg.type === 'browseFolder') {
				opts.canSelectFiles = false;
				opts.canSelectFolders = true;
			} else {
				opts.canSelectFiles = true;
				opts.canSelectFolders = false;
				opts.filters = { 'Платформа 1С': ['exe'] };
			}
			if (msg.current && fs.existsSync(msg.current)) opts.defaultUri = vscode.Uri.file(msg.current);
			const picked = await vscode.window.showOpenDialog(opts);
			if (picked && picked.length) panel.webview.postMessage({ type: 'pathPicked', target: msg.target, value: picked[0].fsPath });
			return;
		}
		if (msg.type === 'save') {
			const error = onSave(msg.name, msg.values);
			if (error) {
				panel.webview.postMessage({ type: 'error', text: error });
			} else {
				panel.dispose();
			}
		}
	});
}

function editBaseProfileCommand(item) {
	const name = item && item.profileName;
	const root = getWorkspaceRoot();
	if (!name || !root) return;
	const filePath = psd1Path(root, name);
	const initial = readBaseProfileFile(filePath);
	openProfileEditorPanel('edit', name, initial, (_name, values) => {
		fs.writeFileSync(filePath, '﻿' + buildPsd1(values), 'utf8');
		const activeNote = item.isActiveProfile
			? ' Это активный профиль — чтобы правки применились, переключитесь на базу ещё раз (клик по ней).'
			: '';
		vscode.window.showInformationMessage(`Профиль "${name}" сохранён (файл перезаписан начисто, ручные комментарии не сохраняются).${activeNote}`);
		if (basesTreeProvider) basesTreeProvider.refresh();
		return undefined;
	});
}

function addBaseProfileCommand() {
	const root = getWorkspaceRoot();
	if (!root) return;

	// PlatformPath и логин обычно одни и те же на все базы этой машины —
	// подхватываем их из текущего активного профиля, чтобы не вводить заново.
	const initial = { configBase: '', connectionType: 'File', filePath: '', server: '', ref: '', platformPath: '', user: '', password: '' };
	const activeConfigPath = path.join(root, '.1С', 'config.psd1');
	if (fs.existsSync(activeConfigPath)) {
		const active = readBaseProfileFile(activeConfigPath);
		initial.platformPath = active.platformPath;
		initial.user = active.user;
	}

	openProfileEditorPanel('add', '', initial, (name, values) => {
		if (!name) return 'Нужно имя базы.';
		if (!/^[A-Za-z0-9._-]+$/.test(name)) return 'Только латиница, цифры, точка, дефис, подчёркивание.';
		const filePath = psd1Path(root, name);
		if (fs.existsSync(filePath)) return `Профиль "${name}" уже есть.`;
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, '﻿' + buildPsd1(values), 'utf8');
		vscode.window.showInformationMessage(`База "${name}" добавлена. Кликните по ней в "Базы 1С", чтобы сделать активной.`);
		if (basesTreeProvider) basesTreeProvider.refresh();
		return undefined;
	});
}

// ============================================================================
// Часть 3: дерево метаданных активной базы (Configuration + Extensions/*).
// Читаем XML-выгрузку (DumpConfigToFiles) прямо с диска, без 1cv8/EDT.
// ============================================================================

// Порядок и русские подписи самых частых категорий метаданных; то, чего нет
// в списке, показываем как есть (по имени папки) в конце, по алфавиту.
// Порядок и группировка — как в дереве метаданных самого Конфигуратора
// (проверено по скриншоту реального дерева): "Общие" — отдельный узел,
// внутрь которого свёрнуты все системные разделы (подсистемы, общие
// модули, роли, планы обмена и т.п.), а не плоский список вперемешку со
// справочниками/документами. Порядок verhнеуровневых бизнес-разделов тоже
// как в Конфигураторе: Константы -> Справочники -> Документы -> ... .
const GENERAL_SUBCATEGORIES = [
	'Subsystems', 'CommonModules', 'SessionParameters', 'Roles', 'CommonAttributes',
	'ExchangePlans', 'FilterCriteria', 'EventSubscriptions', 'ScheduledJobs',
	'FunctionalOptions', 'FunctionalOptionsParameters', 'DefinedTypes', 'SettingsStorages',
	'CommonCommands', 'CommandGroups', 'CommonForms', 'Interfaces', 'CommonTemplates',
	'CommonPictures', 'XDTOPackages', 'WebServices', 'HTTPServices', 'WSReferences',
	'StyleItems', 'Styles', 'Languages',
];
const CATEGORY_ORDER = [
	'Constants', 'Catalogs', 'Documents', 'DocumentJournals', 'Enums', 'Reports',
	'DataProcessors', 'ChartsOfCharacteristicTypes', 'ChartsOfAccounts', 'ChartsOfCalculationTypes',
	'InformationRegisters', 'AccumulationRegisters', 'AccountingRegisters', 'CalculationRegisters',
	'BusinessProcesses', 'Tasks', 'ExternalDataSources',
];
const CATEGORY_LABELS = {
	Subsystems: 'Подсистемы', CommonModules: 'Общие модули', SessionParameters: 'Параметры сеанса',
	Roles: 'Роли', CommonAttributes: 'Общие реквизиты', Constants: 'Константы', Catalogs: 'Справочники',
	Documents: 'Документы', DocumentJournals: 'Журналы документов', Enums: 'Перечисления', Reports: 'Отчёты',
	DataProcessors: 'Обработки', InformationRegisters: 'Регистры сведений', AccumulationRegisters: 'Регистры накопления',
	AccountingRegisters: 'Регистры бухгалтерии', CalculationRegisters: 'Регистры расчёта',
	ChartsOfCharacteristicTypes: 'Планы видов характеристик', ChartsOfAccounts: 'Планы счетов',
	ChartsOfCalculationTypes: 'Планы видов расчёта', BusinessProcesses: 'Бизнес-процессы', Tasks: 'Задачи',
	ExchangePlans: 'Планы обмена', FilterCriteria: 'Критерии отбора', ScheduledJobs: 'Регламентные задания',
	HTTPServices: 'HTTP-сервисы', WebServices: 'Web-сервисы', WSReferences: 'WS-ссылки', XDTOPackages: 'Пакеты XDTO',
	EventSubscriptions: 'Подписки на события', FunctionalOptions: 'Функциональные опции',
	FunctionalOptionsParameters: 'Параметры функц. опций', DefinedTypes: 'Определяемые типы',
	SettingsStorages: 'Хранилища настроек', CommonForms: 'Общие формы', CommonCommands: 'Общие команды',
	CommandGroups: 'Группы команд', CommonPictures: 'Общие картинки', CommonTemplates: 'Общие макеты',
	Languages: 'Языки', Styles: 'Стили', StyleItems: 'Элементы стиля', Interfaces: 'Интерфейсы',
	ExternalDataSources: 'Внешние источники данных',
};
// Иконки по категориям — в Конфигураторе у каждого раздела своя картинка,
// у нас codicon вместо неё (свой набор SVG на 40+ разделов — за пределами
// разумного здесь), но хотя бы не один и тот же значок на всё дерево.
const CATEGORY_ICONS = {
	Constants: 'symbol-constant', Catalogs: 'book', Documents: 'note', DocumentJournals: 'checklist',
	Enums: 'symbol-enum', Reports: 'graph', DataProcessors: 'tools',
	ChartsOfCharacteristicTypes: 'symbol-class', ChartsOfAccounts: 'law', ChartsOfCalculationTypes: 'symbol-numeric',
	InformationRegisters: 'table', AccumulationRegisters: 'database', AccountingRegisters: 'law',
	CalculationRegisters: 'symbol-numeric', BusinessProcesses: 'git-merge', Tasks: 'checklist',
	ExternalDataSources: 'plug',
	Subsystems: 'list-tree', CommonModules: 'code', SessionParameters: 'symbol-parameter', Roles: 'key',
	CommonAttributes: 'symbol-field', ExchangePlans: 'sync', FilterCriteria: 'filter',
	EventSubscriptions: 'zap', ScheduledJobs: 'watch', FunctionalOptions: 'settings-gear',
	FunctionalOptionsParameters: 'settings', DefinedTypes: 'symbol-parameter', SettingsStorages: 'archive',
	CommonCommands: 'terminal', CommandGroups: 'folder', CommonForms: 'layout', Interfaces: 'preview',
	CommonTemplates: 'file-code', CommonPictures: 'file-media', XDTOPackages: 'package',
	WebServices: 'globe', HTTPServices: 'broadcast', WSReferences: 'link', StyleItems: 'symbol-color',
	Styles: 'paintcan', Languages: 'globe',
};
// SVG-пиктограммы вместо кодиконов там, где есть подходящая — набор из
// vscode-1c-metadata-viewer (MIT, см. resources/metadata-icons/README.md),
// ближе к тому, что реально рисует сам Конфигуратор, чем обобщённые
// codicon'ы выше (те остаются как запасной вариант для категорий без своей
// пиктограммы в этом наборе).
const CATEGORY_SVG_ICONS = {
	Constants: 'constant', Catalogs: 'catalog', Documents: 'document', DocumentJournals: 'documentJournal',
	Enums: 'enum', Reports: 'report', DataProcessors: 'dataProcessor',
	ChartsOfCharacteristicTypes: 'chartsOfCharacteristicType', ChartsOfAccounts: 'chartsOfAccount',
	ChartsOfCalculationTypes: 'chartsOfCalculationType', InformationRegisters: 'informationRegister',
	AccumulationRegisters: 'accumulationRegister', AccountingRegisters: 'accountingRegister',
	CalculationRegisters: 'calculationRegister', BusinessProcesses: 'businessProcess', Tasks: 'task',
	ExternalDataSources: 'externalDataSource', Subsystems: 'subsystem', CommonModules: 'commonModule',
	SessionParameters: 'sessionParameter', Roles: 'role', CommonAttributes: 'commonAttribute',
	ExchangePlans: 'exchangePlan', FilterCriteria: 'filterCriteria', EventSubscriptions: 'eventSubscription',
	ScheduledJobs: 'scheduledJob', CommonCommands: 'commonCommand', CommonForms: 'commonForm', CommonTemplates: 'commonTemplate',
	CommonPictures: 'commonPicture', WebServices: 'ws', HTTPServices: 'http', WSReferences: 'wsLink', Styles: 'style',
	FunctionalOptions: 'functionalOption', FunctionalOptionsParameters: 'functionalOptionsParameter',
	DefinedTypes: 'definedType', SettingsStorages: 'settingsStorage', CommandGroups: 'commandGroup',
	XDTOPackages: 'xdtoPackage', StyleItems: 'styleItem', Languages: 'language', Interfaces: 'interface',
	__common__: 'common',
};

function categoryIcon(categoryFolder) {
	const svgName = CATEGORY_SVG_ICONS[categoryFolder];
	if (svgName) {
		const dark = path.join(__dirname, 'resources', 'metadata-icons', 'dark', `${svgName}.svg`);
		const light = path.join(__dirname, 'resources', 'metadata-icons', 'light', `${svgName}.svg`);
		if (fs.existsSync(dark) && fs.existsSync(light)) {
			return { light: vscode.Uri.file(light), dark: vscode.Uri.file(dark) };
		}
	}
	return new vscode.ThemeIcon(CATEGORY_ICONS[categoryFolder] || 'symbol-namespace');
}
// Единственное число тега метаданных — как называется каждый элемент <ChildObjects>
// в корневом Configuration.xml (нужно для заимствования: там строки вида
// <Catalog>Имя</Catalog>, а не <Catalogs>Имя</Catalogs>).
const CATEGORY_SINGULAR = {
	Catalogs: 'Catalog', Documents: 'Document', DocumentJournals: 'DocumentJournal', Enums: 'Enum',
	Reports: 'Report', DataProcessors: 'DataProcessor', InformationRegisters: 'InformationRegister',
	AccumulationRegisters: 'AccumulationRegister', AccountingRegisters: 'AccountingRegister',
	CalculationRegisters: 'CalculationRegister', ChartsOfCharacteristicTypes: 'ChartOfCharacteristicTypes',
	ChartsOfAccounts: 'ChartOfAccounts', ChartsOfCalculationTypes: 'ChartOfCalculationTypes',
	BusinessProcesses: 'BusinessProcess', Tasks: 'Task', ExchangePlans: 'ExchangePlan',
	FilterCriteria: 'FilterCriterion', ScheduledJobs: 'ScheduledJob', HTTPServices: 'HTTPService',
	WebServices: 'WebService', WSReferences: 'WSReference', XDTOPackages: 'XDTOPackage',
	EventSubscriptions: 'EventSubscription', FunctionalOptions: 'FunctionalOption',
	FunctionalOptionsParameters: 'FunctionalOptionsParameter', DefinedTypes: 'DefinedType',
	SettingsStorages: 'SettingsStorage', CommonForms: 'CommonForm', CommonCommands: 'CommonCommand',
	CommandGroups: 'CommandGroup', CommonPictures: 'CommonPicture', CommonTemplates: 'CommonTemplate',
	CommonModules: 'CommonModule', CommonAttributes: 'CommonAttribute', Roles: 'Role',
	Subsystems: 'Subsystem', Constants: 'Constant', SessionParameters: 'SessionParameter',
	Languages: 'Language', Styles: 'Style', StyleItems: 'StyleItem', Interfaces: 'Interface',
	ExternalDataSources: 'ExternalDataSource',
};

// Категории, у объектов которых в 1С бывают предопределённые элементы.
const PREDEFINABLE_CATEGORIES = new Set([
	'Catalogs', 'ChartsOfCharacteristicTypes', 'ChartsOfAccounts', 'ChartsOfCalculationTypes', 'Enums',
]);

let metadataTreeProvider;

// Фильтр дерева метаданных по подсистеме: null — фильтр выключен, иначе
// { key: "Тип.Имя_подсистемы", label, members: Set<"Тип.Имя"> } — построен из
// <Content> подсистемы (список членов подсистемы в её же XML). Живёт как
// состояние провайдера, не кэша: переключение не трогает categoryObjectsCache
// (список объектов категории не изменился, меняется только то, что из него
// показывать), поэтому используется repaint(), а не полный refresh().
let subsystemFilter = null;

// ConfigBase активного профиля читаем напрямую из .1С/config.psd1 (его же
// перезаписывает switch-base.ps1) — без похода в PowerShell на каждый рендер
// дерева. Пусто/нет файла => "Болванка" (см. common.ps1: то же правило).
function activeConfigBase(root) {
	const configPath = path.join(root, '.1С', 'config.psd1');
	if (!fs.existsSync(configPath)) return 'Болванка';
	const text = fs.readFileSync(configPath, 'utf8');
	const m = text.match(/ConfigBase\s*=\s*"([^"]*)"/);
	const value = m ? m[1].trim() : '';
	return value || 'Болванка';
}

function activeBasePaths() {
	const root = getWorkspaceRoot();
	if (!root) return undefined;
	const configBase = activeConfigBase(root);
	const baseDir = path.join(root, 'Configurations', configBase);
	return {
		configBase,
		baseDir,
		configurationDir: path.join(baseDir, 'Configuration'),
		extensionsDir: path.join(baseDir, 'Extensions'),
	};
}

function safeReaddir(dir) {
	try {
		return fs.readdirSync(dir, { withFileTypes: true });
	} catch (e) {
		return [];
	}
}

// 8000 байт с запасом — не 1500: на реальном объекте (Catalogs/Магазины в
// tkz_UnixRT) <ObjectBelonging> лежит на байте 2454 (InternalInfo с пятью
// GeneratedType-блоками перед ним растягивается на объекты посложнее ещё
// сильнее). Резать байты смысла нет — цена не в них: как показал замер,
// открытие/закрытие файла даёт ~7 мс САМО ПО СЕБЕ (похоже на антивирус,
// сканирующий каждый open), а несколько лишних килобайт внутри уже
// открытого файла — доли микросекунды. Экономить нужно было на количестве
// файловых операций (readdir/кэш), не на размере буфера — что и сделано
// ниже; здесь важно не потерять корректность метки "заимствован".
// Синхронный вариант — для разовых проверок (заимствование одного объекта),
// не для дерева: там счёт идёт на сотни файлов за один рендер, см. ниже
// readObjectBelongingAsync + belongingCache.
function readObjectBelonging(filePath) {
	try {
		const fd = fs.openSync(filePath, 'r');
		const buf = Buffer.alloc(8000);
		const bytesRead = fs.readSync(fd, buf, 0, 8000, 0);
		fs.closeSync(fd);
		const text = buf.toString('utf8', 0, bytesRead);
		const m = text.match(/<ObjectBelonging>(\w+)<\/ObjectBelonging>/);
		return m ? m[1] : 'Own';
	} catch (e) {
		return 'Own';
	}
}

// Кэш дерева метаданных: без него КАЖДОЕ раскрытие узла заново стучится в
// диск (для 500+ объектов в категории — сотни syscall на пустом месте,
// плюс синхронные, блокирующие весь extension host, т.е. на время чтения
// зависает не только это дерево, а вся панель VS Code). Кэш живёт до
// команды "Обновить" или переключения базы (см. refresh()); в рамках одной
// сессии структура метаданных обычно не меняется сама по себе — правки
// делает либо пользователь через "Обновить", либо явный деплой.
const categoryObjectsCache = new Map(); // dir -> MetadataObjectItem[]
const belongingCache = new Map(); // xmlPath -> 'Own'|'Adopted'

async function readObjectBelongingAsync(filePath) {
	if (belongingCache.has(filePath)) return belongingCache.get(filePath);
	let value = 'Own';
	try {
		const fh = await fs.promises.open(filePath, 'r');
		try {
			const buf = Buffer.alloc(8000);
			const { bytesRead } = await fh.read(buf, 0, 8000, 0);
			const text = buf.toString('utf8', 0, bytesRead);
			const m = text.match(/<ObjectBelonging>(\w+)<\/ObjectBelonging>/);
			if (m) value = m[1];
		} finally {
			await fh.close();
		}
	} catch (e) {
		// Own по умолчанию — файл мог исчезнуть между readdir и открытием.
	}
	belongingCache.set(filePath, value);
	return value;
}

// Параллельно, с ограничением одновременных открытых файлов — иначе на
// категории в тысячи объектов упрёмся в лимит файловых дескрипторов ОС.
// Асинхронность (в отличие от старого readSync в цикле) не держит
// extension host заблокированным на время чтения — VS Code остаётся
// отзывчивым, пока идёт разбор.
async function readBelongingBatch(paths) {
	const result = new Map();
	let idx = 0;
	const CONCURRENCY = 24;
	async function worker() {
		while (idx < paths.length) {
			const p = paths[idx++];
			result.set(p, await readObjectBelongingAsync(p));
		}
	}
	await Promise.all(Array.from({ length: Math.min(CONCURRENCY, paths.length) }, worker));
	return result;
}

class MetadataRootItem extends vscode.TreeItem {
	// kind: 'configuration' | 'extension' | 'external'. "external" — папка вида
	// Configurations/<База>/ExternalReports (сиблинг Configuration/Extensions):
	// внешние обработки/отчёты, у неё нет категорий метаданных (Catalogs,
	// Documents...) — сразу список собственных подпапок (по одной на объект).
	constructor(label, dir, kind, extName) {
		super(label, vscode.TreeItemCollapsibleState.Collapsed);
		const icons = { configuration: 'database', extension: 'extensions', external: 'file-binary' };
		this.iconPath = new vscode.ThemeIcon(icons[kind] || 'database');
		this.dir = dir;
		this.kind = kind;
		this.isExtension = kind === 'extension'; // для существующих мест, где это уже проверяется
		this.extName = extName;
		this.contextValue = 'metadata-root';
	}
}

class MetadataCategoryItem extends vscode.TreeItem {
	constructor(categoryFolder, dir, root) {
		super(CATEGORY_LABELS[categoryFolder] || categoryFolder, vscode.TreeItemCollapsibleState.Collapsed);
		this.iconPath = categoryIcon(categoryFolder);
		this.dir = dir;
		this.categoryFolder = categoryFolder;
		this.root = root;
		this.contextValue = 'metadata-category';
	}
}

// Узел "Общие" — как в Конфигураторе: системные разделы (подсистемы, общие
// модули, роли, планы обмена, ...) свёрнуты сюда, а не перемешаны в общем
// списке со справочниками/документами.
class MetadataGeneralGroupItem extends vscode.TreeItem {
	constructor(dir, root) {
		super('Общие', vscode.TreeItemCollapsibleState.Collapsed);
		this.iconPath = categoryIcon('__common__');
		this.dir = dir;
		this.root = root;
		this.contextValue = 'metadata-general-group';
	}
}

// Обёртки верхнего уровня: "Расширения" (все Extensions/*) и "Внешние"
// (все ExternalReports/ExternalDataProcessors/... по базе — не только
// отчёты, обработки и внешние печатные формы живут в папках той же формы
// External*) — чтобы не мешать их в один плоский список с "Конфигурацией".
// children — уже готовые MetadataRootItem, посчитанные в getRoots().
class MetadataFolderGroupItem extends vscode.TreeItem {
	constructor(label, icon, contextValue, children) {
		super(label, vscode.TreeItemCollapsibleState.Collapsed);
		this.iconPath = new vscode.ThemeIcon(icon);
		this.contextValue = contextValue;
		this.children = children;
	}
}

class MetadataObjectItem extends vscode.TreeItem {
	// belonging передаётся уже вычисленным (см. getObjects) — ни одного
	// обращения к диску в конструкторе, поэтому создание сотен элементов
	// списка само по себе почти бесплатно.
	constructor(name, xmlPath, subDir, categoryFolder, root, belonging) {
		const hasChildren = !!subDir;
		super(name, hasChildren ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
		this.xmlPath = xmlPath;
		this.subDir = subDir;
		this.categoryFolder = categoryFolder;
		this.root = root; // { dir, isExtension, extName }
		this.command = { command: 'vscode.open', title: 'Открыть', arguments: [vscode.Uri.file(xmlPath)] };
		if (root.isExtension) {
			if (belonging === 'Adopted') {
				this.description = 'заимствован';
				this.iconPath = new vscode.ThemeIcon('link', new vscode.ThemeColor('charts.yellow'));
				this.contextValue = 'metadata-object-adopted';
			} else {
				this.iconPath = new vscode.ThemeIcon('symbol-object');
				this.contextValue = 'metadata-object-own-ext';
			}
		} else {
			this.iconPath = new vscode.ThemeIcon('symbol-object');
			this.contextValue = 'metadata-object-own-root';
		}
		// Отдельные суффиксы contextValue — чтобы пункты меню "Предопределённые
		// элементы" и "Фильтр по подсистеме" показывались только там, где они
		// вообще имеют смысл, а не на каждом объекте подряд.
		if (PREDEFINABLE_CATEGORIES.has(categoryFolder)) this.contextValue += '-predefinable';
		if (categoryFolder === 'Subsystems') this.contextValue += '-subsystem';
	}
}

// Ищет файл с точным именем внутри поддерева, не глубже maxDepth — узко
// используется только для папки конкретной формы/макета (Forms/ИмяФормы,
// Templates/ИмяМакета), не для произвольного обхода: там, где реально лежит
// Form.xml/Template.xml, вложенность максимум Ext/ или Ext/Form/, поэтому
// 3 уровней с запасом достаточно и лишнего по всему дереву не сканирует.
function findNestedFile(dir, filename, maxDepth) {
	const direct = safeReaddir(dir);
	for (const e of direct) {
		if (e.isFile() && e.name === filename) return path.join(dir, e.name);
	}
	if (maxDepth <= 1) return undefined;
	for (const e of direct) {
		if (e.isDirectory()) {
			const found = findNestedFile(path.join(dir, e.name), filename, maxDepth - 1);
			if (found) return found;
		}
	}
	return undefined;
}

class MetadataFileItem extends vscode.TreeItem {
	constructor(name, fullPath, isDir) {
		super(name, isDir ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
		this.fullPath = fullPath;
		this.isDir = isDir;
		this.iconPath = isDir ? vscode.ThemeIcon.Folder : vscode.ThemeIcon.File;
		this.resourceUri = vscode.Uri.file(fullPath);
		if (!isDir) {
			this.command = { command: 'vscode.open', title: 'Открыть', arguments: [vscode.Uri.file(fullPath)] };
			this.contextValue = name === 'Form.xml' ? 'metadata-form-file'
				: name === 'Template.xml' ? 'metadata-template-file'
				: 'metadata-file';
			return;
		}
		// Папка формы/макета (родитель — Forms/ или Templates/) — кнопка сразу
		// на неё, не дожидаясь раскрытия до собственно Form.xml/Template.xml.
		// Поиск узкий (см. findNestedFile) — не сканирует всё дерево, только
		// содержимое этой одной папки.
		const parentName = path.basename(path.dirname(fullPath));
		if (parentName === 'Forms') {
			const formXml = findNestedFile(fullPath, 'Form.xml', 3);
			if (formXml) { this.contextValue = 'metadata-formdir'; this.formXmlPath = formXml; }
		} else if (parentName === 'Templates') {
			const templateXml = findNestedFile(fullPath, 'Template.xml', 3);
			if (templateXml) { this.contextValue = 'metadata-templatedir'; this.templateXmlPath = templateXml; }
		}
	}
}

class MetadataTreeProvider {
	constructor() {
		this._onDidChangeTreeData = new vscode.EventEmitter();
		this.onDidChangeTreeData = this._onDidChangeTreeData.event;
	}
	refresh() {
		categoryObjectsCache.clear();
		belongingCache.clear();
		this._onDidChangeTreeData.fire();
	}
	// Перерисовать без сброса кэша — для фильтра по подсистеме: список
	// объектов категории не изменился на диске, меняется только то, какие
	// из уже прочитанных элементов показывать.
	repaint() {
		this._onDidChangeTreeData.fire();
	}
	getTreeItem(element) { return element; }

	getChildren(element) {
		if (!element) return this.getRoots();
		if (element instanceof MetadataRootItem) {
			// "external" (ExternalReports/ExternalDataProcessors) — плоский список
			// подпапок (по одной на обработку/отчёт), категорий метаданных там нет.
			return element.kind === 'external' ? this.getFiles(element.dir) : this.getCategories(element);
		}
		if (element instanceof MetadataGeneralGroupItem) return this.getGeneralSubcategories(element);
		if (element instanceof MetadataFolderGroupItem) return element.children;
		if (element instanceof MetadataCategoryItem) return this.getObjects(element);
		if (element instanceof MetadataObjectItem) return this.getFiles(element.subDir);
		if (element instanceof MetadataFileItem) return this.getFiles(element.fullPath);
		return [];
	}

	getRoots() {
		const paths = activeBasePaths();
		if (!paths) {
			const item = new vscode.TreeItem('Нет открытого воркспейса');
			item.iconPath = new vscode.ThemeIcon('info');
			return [item];
		}
		const roots = [];
		if (fs.existsSync(paths.configurationDir)) {
			roots.push(new MetadataRootItem(`Конфигурация (${paths.configBase})`, paths.configurationDir, 'configuration', undefined));
		} else {
			const item = new vscode.TreeItem(`Нет папки Configuration в "${paths.configBase}"`);
			item.iconPath = new vscode.ThemeIcon('warning');
			return [item];
		}
		// Расширения — отдельной свёрнутой группой, не вперемешку с "Конфигурацией".
		const extensionRoots = [];
		for (const entry of safeReaddir(paths.extensionsDir)) {
			if (entry.isDirectory()) {
				extensionRoots.push(new MetadataRootItem(entry.name, path.join(paths.extensionsDir, entry.name), 'extension', entry.name));
			}
		}
		if (extensionRoots.length > 0) {
			roots.push(new MetadataFolderGroupItem('Расширения', 'extensions', 'metadata-extensions-group', extensionRoots));
		}

		// Сиблинги Configuration/Extensions вида ExternalReports,
		// ExternalDataProcessors — внешние отчёты/обработки/печатные формы базы
		// (build/*.erf,*.epf + src/ с исходником), у каждого свой смысл, но все
		// они "внешнее" в одном общем смысле — сводим в одну группу, а не по
		// отдельному корню на каждый вид. Маска External*, а не жёстко зашитые
		// имена — конвенция была не везде сразу (пока так только у AlanRT).
		const EXTERNAL_LABELS = {
			ExternalReports: 'Внешние отчёты',
			ExternalDataProcessors: 'Внешние обработки',
			ExternalPrintForms: 'Внешние печатные формы',
		};
		const externalRoots = [];
		for (const entry of safeReaddir(paths.baseDir)) {
			if (entry.isDirectory() && entry.name.startsWith('External')) {
				const label = EXTERNAL_LABELS[entry.name] || entry.name;
				externalRoots.push(new MetadataRootItem(label, path.join(paths.baseDir, entry.name), 'external', entry.name));
			}
		}
		if (externalRoots.length > 0) {
			roots.push(new MetadataFolderGroupItem('Внешние', 'file-submodule', 'metadata-external-group', externalRoots));
		}
		return roots;
	}

	getCategories(rootItem) {
		const present = new Set(safeReaddir(rootItem.dir).filter((e) => e.isDirectory()).map((e) => e.name));
		const rootRef = { dir: rootItem.dir, isExtension: rootItem.isExtension, extName: rootItem.extName };
		const items = [];
		if (GENERAL_SUBCATEGORIES.some((c) => present.has(c))) {
			items.push(new MetadataGeneralGroupItem(rootItem.dir, rootRef));
		}
		const ordered = CATEGORY_ORDER.filter((c) => present.has(c));
		for (const c of ordered) items.push(new MetadataCategoryItem(c, path.join(rootItem.dir, c), rootRef));
		// "Ext" — не категория метаданных, а служебная папка самой Конфигурации
		// (модуль управляемого приложения, модуль сеанса, логотип, заставка,
		// справка — собственные свойства корня, не список дочерних объектов).
		// Есть в КАЖДОЙ базе репозитория, и раньше висела в хвосте дерева как
		// будто это ещё один раздел объектов — убираем, а не оставляем в общем
		// списке "неизвестных".
		const known = new Set([...CATEGORY_ORDER, ...GENERAL_SUBCATEGORIES, 'Ext']);
		const rest = [...present].filter((c) => !known.has(c)).sort();
		for (const c of rest) items.push(new MetadataCategoryItem(c, path.join(rootItem.dir, c), rootRef));
		return items;
	}

	getGeneralSubcategories(groupItem) {
		const present = new Set(safeReaddir(groupItem.dir).filter((e) => e.isDirectory()).map((e) => e.name));
		const ordered = GENERAL_SUBCATEGORIES.filter((c) => present.has(c));
		return ordered.map((c) => new MetadataCategoryItem(c, path.join(groupItem.dir, c), groupItem.root));
	}

	async getObjects(categoryItem) {
		const cached = categoryObjectsCache.get(categoryItem.dir);
		if (cached) return this.applySubsystemFilter(cached, categoryItem.categoryFolder);

		// Один readdir отдаёт сразу и файлы, и папки — папки кладём в Set и
		// узнаём "есть ли у объекта своя подпапка" без отдельного syscall
		// на каждый объект (раньше здесь был fs.existsSync на каждый — на
		// категории в сотни объектов это и было основным тормозом).
		const all = safeReaddir(categoryItem.dir);
		const dirNames = new Set(all.filter((e) => e.isDirectory()).map((e) => e.name));
		const files = all.filter((e) => e.isFile() && e.name.endsWith('.xml'));
		files.sort((a, b) => a.name.localeCompare(b.name, 'ru'));

		let belongingByPath = new Map();
		if (categoryItem.root.isExtension) {
			const xmlPaths = files.map((e) => path.join(categoryItem.dir, e.name));
			belongingByPath = await readBelongingBatch(xmlPaths);
		}

		const items = files.map((e) => {
			const name = e.name.slice(0, -4);
			const xmlPath = path.join(categoryItem.dir, e.name);
			const subDir = dirNames.has(name) ? path.join(categoryItem.dir, name) : undefined;
			return new MetadataObjectItem(name, xmlPath, subDir, categoryItem.categoryFolder, categoryItem.root, belongingByPath.get(xmlPath));
		});
		categoryObjectsCache.set(categoryItem.dir, items);
		return this.applySubsystemFilter(items, categoryItem.categoryFolder);
	}

	// Фильтр не трогает кэш (тот хранит полный список) — применяется на выходе,
	// поэтому включить/выключить фильтр — это repaint(), а не повторное чтение
	// диска. Категории без сопоставимого singular-тега (см. CATEGORY_SINGULAR)
	// в фильтрацию не попадают — не можем построить ключ для сравнения, лучше
	// показать всё, чем молча спрятать без возможности сравнить.
	applySubsystemFilter(items, categoryFolder) {
		if (!subsystemFilter) return items;
		const singular = CATEGORY_SINGULAR[categoryFolder];
		if (!singular) return items;
		return items.filter((it) => subsystemFilter.members.has(`${singular}.${it.label}`));
	}

	getFiles(dir) {
		const entries = safeReaddir(dir);
		entries.sort((a, b) => {
			if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
			return a.name.localeCompare(b.name, 'ru');
		});
		return entries.map((e) => new MetadataFileItem(e.name, path.join(dir, e.name), e.isDirectory()));
	}
}

function copyObjectPathCommand(item) {
	if (item && item.xmlPath) {
		vscode.env.clipboard.writeText(item.xmlPath);
		vscode.window.setStatusBarMessage('$(check) Путь скопирован', 3000);
	}
}

// ============================================================================
// Часть 4: ER-диаграмма объекта (Mermaid, офлайн, без внешних библиотек 1С).
// Разбор — не полноценный XML-парсер, а построчный поиск пар
// <Name>...</Name> + ближайший следующий <v8:Type>ТипСсылка.Имя</v8:Type>:
// для регулярной, предсказуемой выгрузки DumpConfigToFiles этого достаточно,
// чтобы вытащить реквизиты/измерения/ресурсы, ссылающиеся на другие объекты.
// Движения регистров документом сюда не входят — в дескрипторе документа их
// нет как готового списка, это отдельная, более сложная тема.
// ============================================================================

function parseReferences(xmlText) {
	const tokenRe = /<Name>([^<]+)<\/Name>|<v8:Type>(?:cfg:)?(\w+)Ref\.([^<]+)<\/v8:Type>/g;
	const edges = [];
	let lastName = null;
	let m;
	while ((m = tokenRe.exec(xmlText)) !== null) {
		if (m[1] !== undefined) {
			lastName = m[1];
		} else if (lastName) {
			edges.push({ from: lastName, kind: m[2], target: m[3] });
		}
	}
	// Дедуп: одна и та же пара (реквизит -> цель) может повториться, если тип
	// составной и один и тот же <v8:Type> случайно поймался дважды рядом.
	const seen = new Set();
	return edges.filter((e) => {
		const key = `${e.from}|${e.kind}|${e.target}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

const KIND_LABELS = {
	Catalog: 'Справочник', Document: 'Документ', Enum: 'Перечисление', ChartOfCharacteristicTypes: 'ПВХ',
	ChartOfAccounts: 'ПланСчетов', ChartOfCalculationTypes: 'ПВР', BusinessProcess: 'БизнесПроцесс',
	Task: 'Задача', ExchangePlan: 'ПланОбмена',
};

function buildMermaid(selfName, edges) {
	const idOf = (() => {
		let n = 0;
		const map = new Map();
		return (key) => {
			if (!map.has(key)) map.set(key, 'n' + n++);
			return map.get(key);
		};
	})();
	const selfId = idOf('self');
	const lines = ['graph LR', `${selfId}["${selfName}"]`, `style ${selfId} fill:#2d5,stroke:#151,color:#000`];
	const targetIds = new Map();
	for (const e of edges.slice(0, 80)) {
		const targetKey = `${e.kind}.${e.target}`;
		let tid = targetIds.get(targetKey);
		if (!tid) {
			tid = idOf(targetKey);
			targetIds.set(targetKey, tid);
			const label = (KIND_LABELS[e.kind] || e.kind) + '.' + e.target;
			lines.push(`${tid}["${label}"]`);
		}
		lines.push(`${selfId} -->|${e.from}| ${tid}`);
	}
	if (edges.length === 0) {
		lines.push(`${idOf('none')}["нет ссылочных реквизитов/измерений"]`);
	}
	return lines.join('\n');
}

let erPanel;

async function showErDiagramCommand(item) {
	if (!item || !item.xmlPath) return;
	let text;
	try {
		text = fs.readFileSync(item.xmlPath, 'utf8');
	} catch (e) {
		vscode.window.showErrorMessage(`Не удалось прочитать ${item.xmlPath}: ${e.message}`);
		return;
	}
	const edges = parseReferences(text);
	const label = `${CATEGORY_LABELS[item.categoryFolder] || item.categoryFolder}.${item.label}`;
	const mermaid = buildMermaid(label, edges);

	const panel = vscode.window.createWebviewPanel(
		'oneCLauncherEr',
		`ER: ${item.label}`,
		vscode.ViewColumn.Beside,
		{ enableScripts: true, localResourceRoots: [vscode.Uri.file(path.join(__dirname, 'resources'))] }
	);
	erPanel = panel;
	const mermaidUri = panel.webview.asWebviewUri(vscode.Uri.file(path.join(__dirname, 'resources', 'mermaid.min.js')));
	panel.webview.html = `<!doctype html><html><head><meta charset="utf-8">
<style>
	body { background:#1e1e1e; color:#ddd; font-family: var(--vscode-font-family, sans-serif); padding: 12px; }
	.mermaid { text-align: left; }
	h2 { font-weight: normal; opacity: .8; }
</style></head>
<body>
<h2>${label} — ссылочные реквизиты (только прямые, без движений регистров)</h2>
<pre class="mermaid">${mermaid}</pre>
<script src="${mermaidUri}"></script>
<script>
	mermaid.initialize({ startOnLoad: true, theme: 'dark' });
</script>
</body></html>`;
}

// ============================================================================
// Часть 4б: визуализация формы (Form.xml -> схематичный макет в вебвью).
//
// Управляемая форма 1С в XML-выгрузке — это единообразное дерево: любой
// видимый элемент лежит в чьём-то <ChildItems>, и вид виджета определяется
// именем тега (UsualGroup, Pages/Page, Table, InputField, ...). Ниже —
// маленький собственный XML->дерево парсер (без внешних зависимостей: этого
// достаточно для предсказуемой, всегда хорошо сформированной выгрузки
// DumpConfigToFiles) и рендер этого дерева в схематичный HTML-макет —
// не пиксель-в-пиксель как в Конфигураторе, а структурная схема: границы
// групп, вкладки, таблица с колонками, поля с подписями. Проверено на трёх
// реальных формах разных видов (простые поля, вложенные группы+вкладки,
// табличная часть) перед тем, как класть в расширение — см. проверочный
// скрипт в истории разработки.
// ============================================================================

function parseXmlTree(text) {
	const tagRe = /<\?xml[^>]*\?>|<!--[\s\S]*?-->|<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+="[^"]*")*)\s*(\/?)>|([^<]+)/g;
	const root = { tag: '#root', attrs: {}, children: [] };
	const stack = [root];
	let m;
	while ((m = tagRe.exec(text)) !== null) {
		if (m[5] !== undefined) {
			const top = stack[stack.length - 1];
			top.text = (top.text || '') + m[5];
			continue;
		}
		if (!m[2]) continue; // комментарий или <?xml ... ?>
		const tag = m[2];
		if (m[1] === '/') {
			for (let i = stack.length - 1; i > 0; i--) {
				if (stack[i].tag === tag) { stack.length = i; break; }
			}
			continue;
		}
		const attrs = {};
		const attrRe = /([\w:.-]+)="([^"]*)"/g;
		let am;
		while ((am = attrRe.exec(m[3] || '')) !== null) attrs[am[1]] = am[2];
		const node = { tag, attrs, children: [] };
		stack[stack.length - 1].children.push(node);
		if (m[4] !== '/') stack.push(node);
	}
	return root;
}

function xmlFindChild(node, tag) { return node && node.children.find((c) => c.tag === tag); }
function xmlFindChildren(node, tag) { return node ? node.children.filter((c) => c.tag === tag) : []; }
function xmlTextOf(node) { return node ? (node.text || '').trim() : ''; }
function xmlTitleOf(node) {
	const t = xmlFindChild(node, 'Title');
	if (!t) return '';
	const items = xmlFindChildren(t, 'v8:item');
	const ru = items.find((i) => xmlTextOf(xmlFindChild(i, 'v8:lang')) === 'ru') || items[0];
	return ru ? xmlTextOf(xmlFindChild(ru, 'v8:content')) : '';
}
function xmlDataPathOf(node) { return xmlTextOf(xmlFindChild(node, 'DataPath')); }
function xmlLangTextOf(node, tag) {
	const t = xmlFindChild(node, tag);
	if (!t) return '';
	const items = xmlFindChildren(t, 'v8:item');
	const ru = items.find((i) => xmlTextOf(xmlFindChild(i, 'v8:lang')) === 'ru') || items[0];
	return ru ? xmlTextOf(xmlFindChild(ru, 'v8:content')) : '';
}
function xmlSynonymOf(node) { return xmlLangTextOf(node, 'Synonym'); }
function xmlChildItemsOf(node) {
	const ci = xmlFindChild(node, 'ChildItems');
	return ci ? ci.children : [];
}

function escapeHtml(s) {
	return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const FIELD_ICON = {
	InputField: '✎', LabelField: '▭', CheckBoxField: '☑', RadioButtonField: '◉',
	PictureField: '🖼', LabelDecoration: 'T', PictureDecoration: '🖼',
	SpreadSheetDocumentField: '▦', HTMLDocumentField: '🌐',
};

function renderFormField(node) {
	const icon = FIELD_ICON[node.tag] || '▫';
	const title = xmlTitleOf(node) || node.attrs.name || '';
	const dp = xmlDataPathOf(node);
	return `<div class="fld" title="${escapeHtml(dp || node.tag)}"><span class="ic">${icon}</span>${escapeHtml(title)}</div>`;
}

function renderFormButtonRow(node) {
	const buttons = xmlChildItemsOf(node).filter((c) => c.tag === 'Button' || c.tag === 'Popup');
	if (buttons.length === 0) return '';
	const items = buttons.map((b) => `<span class="btn">${escapeHtml(xmlTitleOf(b) || b.attrs.name || '')}</span>`).join('');
	return `<div class="cmdbar">${items}</div>`;
}

function renderFormTable(node) {
	const title = xmlTitleOf(node) || node.attrs.name || '';
	const rawCols = xmlChildItemsOf(node).filter((c) => c.tag !== 'ContextMenu' && c.tag !== 'ExtendedTooltip' && c.tag !== 'AutoCommandBar');
	const cols = rawCols.map((c) => {
		if (c.tag === 'Column' || c.tag === 'ColumnGroup') {
			const inner = xmlChildItemsOf(c)[0];
			return inner || c;
		}
		return c;
	});
	const headers = cols.map((c) => `<th>${escapeHtml(xmlTitleOf(c) || c.attrs.name || '')}</th>`).join('');
	const cells = cols.map(() => '<td>…</td>').join('');
	return `<div class="tbl-wrap"><div class="tbl-title">▦ ${escapeHtml(title)}</div>` +
		`<table class="tbl"><tr>${headers}</tr><tr>${cells}</tr></table></div>`;
}

function renderFormPages(node) {
	const pages = xmlChildItemsOf(node).filter((c) => c.tag === 'Page');
	const tabs = pages.map((p) => `<span class="tab">${escapeHtml(xmlTitleOf(p) || p.attrs.name || '')}</span>`).join('');
	const bodies = pages.map((p) =>
		`<div class="page"><div class="page-title">${escapeHtml(xmlTitleOf(p) || p.attrs.name || '')}</div>` +
		`<div class="page-body">${xmlChildItemsOf(p).map(renderFormElement).join('')}</div></div>`
	).join('');
	return `<div class="pages"><div class="tabs">${tabs}</div>${bodies}</div>`;
}

function renderFormGroup(node) {
	const title = xmlTitleOf(node) || node.attrs.name || '';
	const body = xmlChildItemsOf(node).map(renderFormElement).join('');
	return `<div class="grp"><div class="grp-title">▢ ${escapeHtml(title)}</div><div class="grp-body">${body}</div></div>`;
}

function renderFormElement(node) {
	switch (node.tag) {
		case 'UsualGroup':
		case 'Popup':
			return renderFormGroup(node);
		case 'Pages':
			return renderFormPages(node);
		case 'Table':
			return renderFormTable(node);
		case 'ButtonGroup':
		case 'CommandBar':
		case 'AutoCommandBar':
			return renderFormButtonRow(node);
		case 'Button':
			return `<span class="btn">${escapeHtml(xmlTitleOf(node) || node.attrs.name || '')}</span>`;
		case 'ContextMenu':
		case 'ExtendedTooltip':
			return '';
		default:
			return renderFormField(node);
	}
}

function findFormFiles(objectDir) {
	const results = [];
	const formsDir = path.join(objectDir, 'Forms');
	if (!fs.existsSync(formsDir)) return results;
	function walk(d) {
		for (const e of safeReaddir(d)) {
			const full = path.join(d, e.name);
			if (e.isDirectory()) walk(full);
			else if (e.name === 'Form.xml') results.push(full);
		}
	}
	walk(formsDir);
	return results.map((p) => {
		const rel = path.relative(formsDir, p);
		const formName = rel.split(path.sep)[0];
		return { name: formName, path: p };
	});
}

let formPanel;

function openFormVisualization(formPath, label) {
	let text;
	try {
		text = fs.readFileSync(formPath, 'utf8');
	} catch (e) {
		vscode.window.showErrorMessage(`Не удалось прочитать ${formPath}: ${e.message}`);
		return;
	}
	const root = parseXmlTree(text);
	const formNode = xmlFindChild(root, 'Form');
	if (!formNode) {
		vscode.window.showErrorMessage('Не удалось разобрать Form.xml (не найден корневой тег <Form>).');
		return;
	}
	const bodyHtml = xmlChildItemsOf(formNode).map(renderFormElement).join('');

	const panel = vscode.window.createWebviewPanel(
		'oneCLauncherFormViz',
		`Форма: ${label}`,
		vscode.ViewColumn.Beside,
		{ enableScripts: false }
	);
	formPanel = panel;
	panel.webview.html = `<!doctype html><html><head><meta charset="utf-8">
<style>
	body { background:#1e1e1e; color:#ddd; font-family: var(--vscode-font-family, sans-serif); padding: 14px; }
	h2 { font-weight: normal; opacity: .75; font-size: 13px; }
	.grp { border: 1px solid #3c3c3c; border-radius: 4px; margin: 6px 0; }
	.grp-title { background:#2a2d2e; padding: 3px 8px; font-size: 11px; opacity: .8; border-bottom: 1px solid #3c3c3c; }
	.grp-body { padding: 6px; display: flex; flex-direction: column; gap: 4px; }
	.fld { border: 1px solid #444; border-radius: 3px; padding: 4px 8px; font-size: 12px; background: #252526; display: flex; gap: 6px; align-items: center; }
	.fld .ic { opacity: .6; }
	.pages { border: 1px solid #3c3c3c; border-radius: 4px; margin: 6px 0; }
	.tabs { display: flex; gap: 2px; background: #2a2d2e; padding: 4px 4px 0; }
	.tab { padding: 4px 10px; font-size: 11px; background: #37373d; border-radius: 4px 4px 0 0; opacity: .85; }
	.page { border-top: 1px solid #3c3c3c; }
	.page-title { font-size: 10px; opacity: .5; padding: 4px 8px 0; }
	.page-body { padding: 6px; display: flex; flex-direction: column; gap: 4px; }
	.tbl-wrap { border: 1px solid #3c3c3c; border-radius: 4px; margin: 6px 0; padding: 6px; }
	.tbl-title { font-size: 11px; opacity: .8; margin-bottom: 4px; }
	.tbl { border-collapse: collapse; font-size: 11px; }
	.tbl th, .tbl td { border: 1px solid #3c3c3c; padding: 3px 8px; text-align: left; }
	.tbl th { background: #2a2d2e; font-weight: normal; opacity: .85; }
	.cmdbar { display: flex; gap: 4px; flex-wrap: wrap; margin: 4px 0; }
	.btn { border: 1px solid #555; border-radius: 3px; padding: 2px 8px; font-size: 11px; background: #2d2d2d; }
</style></head>
<body>
<h2>${escapeHtml(label)} — схема формы (структура, не пиксель-в-пиксель; порядок и раскладка групп внутри 1С может отличаться)</h2>
${bodyHtml || '<i>форма пустая или все элементы отфильтрованы</i>'}
</body></html>`;
}

async function visualizeFormCommand(item) {
	if (!item) return;
	if (item.contextValue === 'metadata-form-file') {
		await openFormVisualization(item.fullPath, path.basename(path.dirname(path.dirname(item.fullPath))));
		return;
	}
	if (item.contextValue === 'metadata-formdir') {
		const objectName = path.basename(path.dirname(path.dirname(item.fullPath)));
		await openFormVisualization(item.formXmlPath, `${objectName} — ${item.label}`);
		return;
	}
	if (item.subDir === undefined) {
		vscode.window.showWarningMessage('Выберите объект метаданных или файл Form.xml.');
		return;
	}
	const objectDir = item.subDir;
	if (!fs.existsSync(objectDir)) {
		vscode.window.showInformationMessage(`У объекта "${item.label}" нет собственной папки (${'нет доп. содержимого, в т.ч. форм'}).`);
		return;
	}
	const forms = findFormFiles(objectDir);
	if (forms.length === 0) {
		vscode.window.showInformationMessage(`У объекта "${item.label}" не нашлось форм (Forms/*/Form.xml).`);
		return;
	}
	if (forms.length === 1) {
		await openFormVisualization(forms[0].path, `${item.label} — ${forms[0].name}`);
		return;
	}
	const picked = await vscode.window.showQuickPick(forms.map((f) => f.name), { placeHolder: `Форма объекта "${item.label}"` });
	if (!picked) return;
	const chosen = forms.find((f) => f.name === picked);
	await openFormVisualization(chosen.path, `${item.label} — ${chosen.name}`);
}

// ============================================================================
// Часть 4б: предопределённые элементы (справочники, ПВХ, планы счетов/видов
// расчёта — из Ext/Predefined.xml; перечисления — прямо из своего XML, у них
// нет отдельного файла, значения лежат в ChildObjects/EnumValue).
// ============================================================================

function normalizePredefinedItems(itemNodes) {
	return itemNodes.map((it) => ({
		name: xmlTextOf(xmlFindChild(it, 'Name')),
		description: xmlTextOf(xmlFindChild(it, 'Description')),
		isFolder: xmlTextOf(xmlFindChild(it, 'IsFolder')) === 'true',
		children: normalizePredefinedItems(xmlChildItemsOf(it)),
	}));
}

function normalizeEnumValues(root) {
	const enumNode = xmlFindChild(root, 'Enum');
	const childObjects = xmlFindChild(enumNode, 'ChildObjects');
	const values = xmlFindChildren(childObjects, 'EnumValue');
	return values.map((v) => {
		const p = xmlFindChild(v, 'Properties');
		return { name: xmlTextOf(xmlFindChild(p, 'Name')), description: xmlSynonymOf(p), isFolder: false, children: [] };
	});
}

function renderPredefinedNode(n) {
	const kids = n.children.length ? `<div class="kids">${n.children.map(renderPredefinedNode).join('')}</div>` : '';
	return `<div class="pd-row"><span class="pd-ic">${n.isFolder ? '▸' : '•'}</span>` +
		`<span class="pd-name">${escapeHtml(n.name)}</span>` +
		(n.description ? `<span class="pd-desc">${escapeHtml(n.description)}</span>` : '') +
		`</div>${kids}`;
}

let predefinedPanel;

async function showPredefinedCommand(item) {
	if (!item || !PREDEFINABLE_CATEGORIES.has(item.categoryFolder)) {
		vscode.window.showInformationMessage('У этого типа объектов не бывает предопределённых элементов.');
		return;
	}
	let nodes;
	try {
		if (item.categoryFolder === 'Enums') {
			const root = parseXmlTree(fs.readFileSync(item.xmlPath, 'utf8'));
			nodes = normalizeEnumValues(root);
			if (nodes.length === 0) {
				vscode.window.showInformationMessage(`У перечисления "${item.label}" нет значений (пустое).`);
				return;
			}
		} else {
			const predefinedPath = item.subDir ? path.join(item.subDir, 'Ext', 'Predefined.xml') : '';
			if (!predefinedPath || !fs.existsSync(predefinedPath)) {
				vscode.window.showInformationMessage(`У "${item.label}" нет предопределённых элементов.`);
				return;
			}
			const root = parseXmlTree(fs.readFileSync(predefinedPath, 'utf8'));
			const dataNode = xmlFindChild(root, 'PredefinedData');
			nodes = normalizePredefinedItems(xmlFindChildren(dataNode, 'Item'));
			if (nodes.length === 0) {
				vscode.window.showInformationMessage(`У "${item.label}" нет предопределённых элементов.`);
				return;
			}
		}
	} catch (e) {
		vscode.window.showErrorMessage(`Не удалось разобрать предопределённые элементы "${item.label}": ${e.message}`);
		return;
	}

	if (predefinedPanel) predefinedPanel.dispose();
	const panel = vscode.window.createWebviewPanel(
		'oneCLauncherPredefined', `Предопределённые: ${item.label}`, vscode.ViewColumn.Beside, { enableScripts: false }
	);
	predefinedPanel = panel;
	panel.onDidDispose(() => { if (predefinedPanel === panel) predefinedPanel = undefined; });
	panel.webview.html = `<!doctype html><html><head><meta charset="utf-8">
<style>
	body { background:#1e1e1e; color:#ddd; font-family: var(--vscode-font-family, sans-serif); padding: 14px; font-size: 13px; }
	h2 { font-weight: normal; opacity: .75; font-size: 13px; }
	.pd-row { display: flex; align-items: baseline; gap: 8px; padding: 3px 0; }
	.pd-ic { opacity: .5; width: 12px; }
	.pd-name { font-family: var(--vscode-editor-font-family, monospace); }
	.pd-desc { opacity: .55; font-size: 12px; }
	.kids { margin-left: 20px; border-left: 1px dashed #3c3c3c; padding-left: 10px; }
</style></head>
<body>
<h2>${escapeHtml(item.label)} — предопределённые элементы (${nodes.length})</h2>
${nodes.map(renderPredefinedNode).join('')}
</body></html>`;
}

// ============================================================================
// Часть 4в: просмотр макета (Template.xml, табличный документ) — грубая
// табличная реконструкция: ширины колонок, объединения ячеек, текст (в т.ч.
// параметры, они рендерятся как плейсхолдер [Имя]). Без шрифтов/заливок/
// границ — как и с формами, это структура, не пиксель-в-пиксель.
// ============================================================================

function parseTemplateGrid(text) {
	const root = parseXmlTree(text);
	const doc = xmlFindChild(root, 'document');
	const colWidths = [];
	const columnsNode = xmlFindChild(doc, 'columns');
	if (columnsNode) {
		for (const ci of xmlFindChildren(columnsNode, 'columnsItem')) {
			const idx = parseInt(xmlTextOf(xmlFindChild(ci, 'index')), 10);
			const col = xmlFindChild(ci, 'column');
			const width = col ? parseInt(xmlTextOf(xmlFindChild(col, 'width')), 10) : NaN;
			colWidths[idx] = Number.isNaN(width) ? 60 : width;
		}
	}

	const rows = [];
	for (const ri of xmlFindChildren(doc, 'rowsItem')) {
		const rowIdx = parseInt(xmlTextOf(xmlFindChild(ri, 'index')), 10);
		const rowNode = xmlFindChild(ri, 'row');
		const cells = [];
		let col = 0;
		for (const c of xmlFindChildren(rowNode, 'c')) {
			const iTag = xmlFindChild(c, 'i');
			if (iTag) col = parseInt(xmlTextOf(iTag), 10);
			const inner = xmlFindChild(c, 'c');
			let text = '', isParam = false;
			if (inner) {
				const param = xmlFindChild(inner, 'parameter');
				if (param) { text = xmlTextOf(param); isParam = true; }
				else text = xmlLangTextOf(inner, 'tl');
			}
			cells.push({ col, text, isParam });
			col += 1;
		}
		rows[rowIdx] = cells;
	}

	const merges = new Map(); // "r,c" -> {rowspan, colspan}
	const skip = new Set(); // ячейки, накрытые чужим merge — не рисуем отдельно
	for (const mg of xmlFindChildren(doc, 'merge')) {
		const r = parseInt(xmlTextOf(xmlFindChild(mg, 'r')), 10);
		const c = parseInt(xmlTextOf(xmlFindChild(mg, 'c')), 10);
		const wTag = xmlFindChild(mg, 'w'), hTag = xmlFindChild(mg, 'h');
		const w = wTag ? parseInt(xmlTextOf(wTag), 10) : 1;
		const h = hTag ? parseInt(xmlTextOf(hTag), 10) : 1;
		if (Number.isNaN(r) || Number.isNaN(c)) continue;
		merges.set(`${r},${c}`, { rowspan: h, colspan: w });
		for (let dr = 0; dr < h; dr++) {
			for (let dc = 0; dc < w; dc++) {
				if (dr === 0 && dc === 0) continue;
				skip.add(`${r + dr},${c + dc}`);
			}
		}
	}

	const maxCol = colWidths.length || rows.reduce((m, r) => (r ? Math.max(m, ...r.map((c) => c.col + 1)) : m), 1);
	return { colWidths, rows, merges, skip, maxCol };
}

function renderTemplateHtml(grid) {
	const colgroup = Array.from({ length: grid.maxCol }, (_, i) =>
		`<col style="width:${Math.max(24, Math.round((grid.colWidths[i] || 60) * 0.75))}px">`
	).join('');
	let body = '';
	for (let r = 0; r < grid.rows.length; r++) {
		const cells = grid.rows[r] || [];
		let tds = '';
		for (let c = 0; c < grid.maxCol; c++) {
			const key = `${r},${c}`;
			if (grid.skip.has(key)) continue;
			const cellData = cells.find((x) => x.col === c);
			const mergeInfo = grid.merges.get(key);
			const attrs = mergeInfo ? ` colspan="${mergeInfo.colspan}" rowspan="${mergeInfo.rowspan}"` : '';
			const cls = cellData && cellData.isParam ? ' class="param"' : '';
			const text = cellData ? (cellData.isParam ? `[${escapeHtml(cellData.text)}]` : escapeHtml(cellData.text)) : '';
			tds += `<td${attrs}${cls}>${text}</td>`;
		}
		body += `<tr>${tds}</tr>`;
	}
	return `<table class="grid"><colgroup>${colgroup}</colgroup>${body}</table>`;
}

function findTemplateFiles(objectDir) {
	const results = [];
	const templatesDir = path.join(objectDir, 'Templates');
	if (!fs.existsSync(templatesDir)) return results;
	function walk(d) {
		for (const e of safeReaddir(d)) {
			const full = path.join(d, e.name);
			if (e.isDirectory()) walk(full);
			else if (e.name === 'Template.xml') results.push(full);
		}
	}
	walk(templatesDir);
	return results.map((p) => {
		const rel = path.relative(templatesDir, p);
		return { name: rel.split(path.sep)[0], path: p };
	});
}

let templatePanel;

function openTemplatePreview(templatePath, label) {
	let text;
	try {
		text = fs.readFileSync(templatePath, 'utf8');
	} catch (e) {
		vscode.window.showErrorMessage(`Не удалось прочитать ${templatePath}: ${e.message}`);
		return;
	}
	let grid;
	try {
		grid = parseTemplateGrid(text);
	} catch (e) {
		vscode.window.showErrorMessage(`Не удалось разобрать макет "${label}": ${e.message}`);
		return;
	}
	if (templatePanel) templatePanel.dispose();
	const panel = vscode.window.createWebviewPanel('oneCLauncherTemplate', `Макет: ${label}`, vscode.ViewColumn.Beside, { enableScripts: false });
	templatePanel = panel;
	panel.onDidDispose(() => { if (templatePanel === panel) templatePanel = undefined; });
	panel.webview.html = `<!doctype html><html><head><meta charset="utf-8">
<style>
	body { background:#fff; color:#111; font-family: var(--vscode-font-family, sans-serif); padding: 14px; }
	h2 { font-weight: normal; opacity: .65; font-size: 13px; }
	.grid { border-collapse: collapse; font-size: 11px; table-layout: fixed; background: #fff; }
	.grid td { border: 1px solid #b8b8b8; padding: 2px 4px; overflow: hidden; text-overflow: ellipsis;
		white-space: nowrap; height: 18px; vertical-align: middle; color: #111; }
	.grid td.param { color: #0b5fd6; font-style: italic; background: rgba(11,95,214,.06); }
</style></head>
<body>
<h2>${escapeHtml(label)} — макет (структура ячеек и объединения; без шрифтов/заливок/границ 1С; [В квадратных скобках] — параметры, заполняются при печати)</h2>
${renderTemplateHtml(grid)}
</body></html>`;
}

async function previewTemplateCommand(item) {
	if (!item) return;
	if (item.contextValue === 'metadata-template-file') {
		openTemplatePreview(item.fullPath, path.basename(path.dirname(path.dirname(item.fullPath))));
		return;
	}
	if (item.contextValue === 'metadata-templatedir') {
		const objectName = path.basename(path.dirname(path.dirname(item.fullPath)));
		openTemplatePreview(item.templateXmlPath, `${objectName} — ${item.label}`);
		return;
	}
	if (item.subDir === undefined) {
		vscode.window.showWarningMessage('Выберите объект метаданных или файл Template.xml.');
		return;
	}
	if (!fs.existsSync(item.subDir)) {
		vscode.window.showInformationMessage(`У объекта "${item.label}" нет собственной папки.`);
		return;
	}
	const templates = findTemplateFiles(item.subDir);
	if (templates.length === 0) {
		vscode.window.showInformationMessage(`У объекта "${item.label}" не нашлось макетов (Templates/*/Template.xml).`);
		return;
	}
	if (templates.length === 1) {
		openTemplatePreview(templates[0].path, `${item.label} — ${templates[0].name}`);
		return;
	}
	const picked = await vscode.window.showQuickPick(templates.map((t) => t.name), { placeHolder: `Макет объекта "${item.label}"` });
	if (!picked) return;
	const chosen = templates.find((t) => t.name === picked);
	openTemplatePreview(chosen.path, `${item.label} — ${chosen.name}`);
}

// ============================================================================
// Часть 4г: фильтр дерева по подсистеме. Подсистема сама — тоже объект
// метаданных (Subsystems/Имя.xml), в её <Content> — плоский список членов
// (<xr:Item xsi:type="xr:MDObjectRef">Тип.Имя</xr:Item>) по всей конфигурации
// вперемешку — не только "бизнес"-объекты, но и общие команды/формы/роли и
// т.д., поэтому фильтр в getObjects применяется ко ВСЕМ категориям одинаково.
// ============================================================================

async function toggleSubsystemFilterCommand(item) {
	if (!item || item.categoryFolder !== 'Subsystems') return;
	const key = `${item.root.dir}::${item.label}`;
	if (subsystemFilter && subsystemFilter.key === key) {
		subsystemFilter = null;
		vscode.window.showInformationMessage('Фильтр по подсистеме снят.');
		if (metadataTreeProvider) metadataTreeProvider.repaint();
		updateProjectViewTitles();
		return;
	}
	let text;
	try {
		text = fs.readFileSync(item.xmlPath, 'utf8');
	} catch (e) {
		vscode.window.showErrorMessage(`Не удалось прочитать ${item.xmlPath}: ${e.message}`);
		return;
	}
	const root = parseXmlTree(text);
	const subsystemNode = xmlFindChild(root, 'Subsystem');
	const contentNode = xmlFindChild(subsystemNode, 'Content');
	const members = new Set(xmlFindChildren(contentNode, 'xr:Item').map((n) => xmlTextOf(n)).filter(Boolean));
	subsystemFilter = { key, label: item.label, members };
	vscode.window.showInformationMessage(`Дерево отфильтровано по подсистеме "${item.label}" (${members.size} объектов). Повторный клик по ней снимает фильтр.`);
	if (metadataTreeProvider) metadataTreeProvider.repaint();
	updateProjectViewTitles();
}

function clearSubsystemFilterCommand() {
	if (!subsystemFilter) return;
	subsystemFilter = null;
	if (metadataTreeProvider) metadataTreeProvider.repaint();
	updateProjectViewTitles();
}

// ============================================================================
// Часть 5: заимствование объекта в расширение.
//
// Генерирует минимальный дескриптор-стаб (ObjectBelonging=Adopted,
// ExtendedConfigurationObject=uuid исходного объекта) по образцу реально
// заимствованных объектов в этом же репозитории (см.
// Configurations/UNIX/RT UNIX/Extensions/tkz_UnixRT/Catalogs/Магазины.xml) и
// дописывает ссылку на объект в <ChildObjects> корневого Configuration.xml
// расширения.
//
// ВАЖНО (честно, не проверено вживую): блок <InternalInfo> с TypeId/ValueId
// в исходнике генерируется платформой заново под каждый контур — сравнение
// показало разные TypeId у одного и того же объекта в конфигурации и в
// расширении. Стаб их не содержит; ожидание — платформа досчитает их сама
// при /LoadConfigFromFiles, как при интерактивном заимствовании через
// Конфигуратор. Это предположение, не факт — поэтому команда НЕ обновляет
// базу данных сама, а только пишет файлы и просит прогнать -PlanOnly.
// ============================================================================

async function borrowObjectCommand(item) {
	if (!item || !item.xmlPath || !item.contextValue.startsWith('metadata-object-own-root')) {
		vscode.window.showWarningMessage('Заимствование доступно только для объекта основной конфигурации.');
		return;
	}
	const paths = activeBasePaths();
	if (!paths) return;

	const extensions = safeReaddir(paths.extensionsDir).filter((e) => e.isDirectory()).map((e) => e.name);
	if (extensions.length === 0) {
		vscode.window.showWarningMessage(`В базе "${paths.configBase}" нет ни одного расширения (Extensions/*).`);
		return;
	}
	const targetExt = await vscode.window.showQuickPick(extensions, { placeHolder: 'В какое расширение заимствовать объект?' });
	if (!targetExt) return;

	const sourceText = fs.readFileSync(item.xmlPath, 'utf8');
	const headerMatch = sourceText.match(/<MetaDataObject\s+([^>]*)>/);
	const rootMatch = sourceText.match(/<MetaDataObject[^>]*>\s*<(\w+) uuid="([0-9a-fA-F-]+)">/);
	const nameMatch = sourceText.match(/<Name>([^<]*)<\/Name>/);
	if (!headerMatch || !rootMatch || !nameMatch) {
		vscode.window.showErrorMessage('Не удалось разобрать исходный XML объекта (неожиданный формат).');
		return;
	}
	const xmlnsAttrs = headerMatch[1];
	const categoryTag = rootMatch[1]; // напр. "Catalog"
	const sourceUuid = rootMatch[2];
	const objectName = nameMatch[1];
	const categoryFolder = item.categoryFolder;

	const extDir = path.join(paths.extensionsDir, targetExt);
	const targetCategoryDir = path.join(extDir, categoryFolder);
	const targetXmlPath = path.join(targetCategoryDir, `${objectName}.xml`);

	if (fs.existsSync(targetXmlPath)) {
		const existingBelonging = readObjectBelonging(targetXmlPath);
		vscode.window.showWarningMessage(
			`"${objectName}" уже есть в расширении "${targetExt}" (${existingBelonging === 'Adopted' ? 'уже заимствован' : 'свой объект расширения'}) — ничего не меняю.`
		);
		await vscode.window.showTextDocument(vscode.Uri.file(targetXmlPath));
		return;
	}

	const newUuid = crypto.randomUUID();
	const BOM = '﻿';
	const stub = `${BOM}<?xml version="1.0" encoding="UTF-8"?>\r\n` +
		`<MetaDataObject ${xmlnsAttrs}>\r\n` +
		`\t<${categoryTag} uuid="${newUuid}">\r\n` +
		`\t\t<Properties>\r\n` +
		`\t\t\t<ObjectBelonging>Adopted</ObjectBelonging>\r\n` +
		`\t\t\t<Name>${objectName}</Name>\r\n` +
		`\t\t\t<Comment/>\r\n` +
		`\t\t\t<ExtendedConfigurationObject>${sourceUuid}</ExtendedConfigurationObject>\r\n` +
		`\t\t</Properties>\r\n` +
		`\t\t<ChildObjects/>\r\n` +
		`\t</${categoryTag}>\r\n` +
		`</MetaDataObject>\r\n`;

	fs.mkdirSync(targetCategoryDir, { recursive: true });
	fs.writeFileSync(targetXmlPath, stub, 'utf8');

	// Прописываем ссылку в <ChildObjects> корневого Configuration.xml расширения.
	const rootConfigPath = path.join(extDir, 'Configuration.xml');
	let insertedLineNumber = null;
	try {
		const singular = CATEGORY_SINGULAR[categoryFolder] || categoryTag;
		let rootConfigText = fs.readFileSync(rootConfigPath, 'utf8');
		const tagRe = new RegExp(`<${singular}>[^<]*</${singular}>`, 'g');
		const matches = [...rootConfigText.matchAll(tagRe)];
		const newEntry = `\t\t\t<${singular}>${objectName}</${singular}>`;
		if (matches.length > 0) {
			const last = matches[matches.length - 1];
			const insertAt = last.index + last[0].length;
			rootConfigText = rootConfigText.slice(0, insertAt) + '\r\n' + newEntry + rootConfigText.slice(insertAt);
		} else {
			const closeIdx = rootConfigText.indexOf('</ChildObjects>');
			if (closeIdx === -1) throw new Error('в Configuration.xml расширения нет <ChildObjects>');
			rootConfigText = rootConfigText.slice(0, closeIdx) + newEntry + '\r\n\t\t' + rootConfigText.slice(closeIdx);
		}
		fs.writeFileSync(rootConfigPath, rootConfigText, 'utf8');
		insertedLineNumber = rootConfigText.slice(0, rootConfigText.indexOf(newEntry) + newEntry.length).split(/\r\n|\n/).length - 1;
	} catch (e) {
		vscode.window.showWarningMessage(
			`Стаб-файл создан, но не удалось дописать ${targetExt}/Configuration.xml автоматически: ${e.message}. ` +
			`Добавьте вручную строку <${CATEGORY_SINGULAR[categoryFolder] || categoryTag}>${objectName}</${CATEGORY_SINGULAR[categoryFolder] || categoryTag}> в <ChildObjects>.`
		);
	}

	if (metadataTreeProvider) metadataTreeProvider.refresh();

	const doc = await vscode.workspace.openTextDocument(targetXmlPath);
	await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One });
	if (insertedLineNumber !== null) {
		const doc2 = await vscode.workspace.openTextDocument(rootConfigPath);
		const editor2 = await vscode.window.showTextDocument(doc2, { viewColumn: vscode.ViewColumn.Beside });
		const pos = new vscode.Position(Math.max(0, insertedLineNumber - 1), 0);
		editor2.selection = new vscode.Selection(pos, pos);
		editor2.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
	}

	vscode.window.showInformationMessage(
		`Черновик заимствования "${objectName}" → "${targetExt}" создан. ` +
		`Это лёгкий стаб (без InternalInfo — платформа должна досчитать его сама при загрузке). ` +
		`ОБЯЗАТЕЛЬНО прогоните деплой с -PlanOnly перед -UpdateDb и проверьте, что объект открывается в Конфигураторе без ошибок.`
	);
}

// ============================================================================
// activate/deactivate
// ============================================================================

// Название базы прямо в заголовке панели ("Задачи — RT UNIX") — контейнер
// "1С: проект" держит именно то, что относится к ТЕКУЩЕЙ активной базе
// (задачи запуска и метаданные), отдельно от "1С" со списком баз/переключением
// — тот выбор, для чего этот контейнер, не должен смешиваться с содержимым
// уже выбранного. Заголовок самого контейнера в activity bar статичен
// (ограничение VS Code), поэтому имя базы — на заголовках вложенных панелей.
let taskTreeView, metadataTreeView;
function updateProjectViewTitles() {
	const root = getWorkspaceRoot();
	const baseName = root ? activeConfigBase(root) : undefined;
	const suffix = baseName ? ` — ${baseName}` : '';
	if (taskTreeView) taskTreeView.title = `Задачи${suffix}`;
	const filterSuffix = subsystemFilter ? ` · фильтр: ${subsystemFilter.label}` : '';
	if (metadataTreeView) metadataTreeView.title = `Метаданные${suffix}${filterSuffix}`;
	vscode.commands.executeCommand('setContext', 'oneCLauncherSubsystemFilterActive', !!subsystemFilter);
}

// Каркас папок, которые ждёт остальная логика расширения (переключение баз,
// дерево метаданных) — если открыть пустой/только что склонированный
// воркспейс, без этого "Добавить базу" не может записать профиль, а
// "Метаданные" покажет только "нет папки Configuration". Создаём молча и
// только то, чего действительно не хватает — никогда не трогаем то, что уже
// есть.
function ensureScaffold(root) {
	const dirs = [
		path.join(root, 'Configurations'),
		path.join(root, '.1С', 'base-profiles'),
	];
	let created = [];
	for (const dir of dirs) {
		if (!fs.existsSync(dir)) {
			try {
				fs.mkdirSync(dir, { recursive: true });
				created.push(path.relative(root, dir));
			} catch (e) {
				// Не критично — просто не создалось (например, нет прав); команды
				// добавления базы/просмотра метаданных сообщат об этом позже сами.
			}
		}
	}
	if (created.length > 0) {
		vscode.window.setStatusBarMessage(`$(info) 1С QazDefense Tools: создал ${created.join(', ')}`, 6000);
	}
}

function activate(context) {
	const root = getWorkspaceRoot();
	if (root) ensureScaffold(root);

	taskTreeProvider = new TaskTreeProvider();
	basesTreeProvider = new BasesTreeProvider();
	metadataTreeProvider = new MetadataTreeProvider();

	taskTreeView = vscode.window.createTreeView('oneCLauncherView', { treeDataProvider: taskTreeProvider });
	metadataTreeView = vscode.window.createTreeView('oneCLauncherMetadata', { treeDataProvider: metadataTreeProvider });
	updateProjectViewTitles();

	context.subscriptions.push(
		taskTreeView,
		metadataTreeView,
		vscode.window.registerTreeDataProvider('oneCLauncherBases', basesTreeProvider),

		vscode.commands.registerCommand('oneCLauncher.runTask', runTaskWithFeedback),
		vscode.commands.registerCommand('oneCLauncher.switchBase', switchBaseCommand),
		vscode.commands.registerCommand('oneCLauncher.editBaseProfile', editBaseProfileCommand),
		vscode.commands.registerCommand('oneCLauncher.addBaseProfile', addBaseProfileCommand),
		vscode.commands.registerCommand('oneCLauncher.refreshBases', () => basesTreeProvider.refresh()),
		vscode.commands.registerCommand('oneCLauncher.refreshMetadata', () => metadataTreeProvider.refresh()),
		vscode.commands.registerCommand('oneCLauncher.showErDiagram', showErDiagramCommand),
		vscode.commands.registerCommand('oneCLauncher.visualizeForm', visualizeFormCommand),
		vscode.commands.registerCommand('oneCLauncher.showPredefined', showPredefinedCommand),
		vscode.commands.registerCommand('oneCLauncher.previewTemplate', previewTemplateCommand),
		vscode.commands.registerCommand('oneCLauncher.toggleSubsystemFilter', toggleSubsystemFilterCommand),
		vscode.commands.registerCommand('oneCLauncher.clearSubsystemFilter', clearSubsystemFilterCommand),
		vscode.commands.registerCommand('oneCLauncher.borrowObject', borrowObjectCommand),
		vscode.commands.registerCommand('oneCLauncher.copyObjectPath', copyObjectPathCommand)
	);
}

function deactivate() {}

module.exports = { activate, deactivate };
