// Генератор оригинального набора пиктограмм категорий метаданных.
// Стиль: штриховые (stroke-based) линейные значки 24x24, простая геометрия
// (rect/circle/line/path из прямых и дуг) — намеренно другой изобразительный
// язык, не силуэты/заливки. Palette — фирменные цвета значка расширения
// (тёмно-зелёный/светло-зелёный из icon-brand.png).
const fs = require('fs');
const path = require('path');

const DARK_COLOR = '#6FFF8F'; // на тёмном сайдбаре
const LIGHT_COLOR = '#1F6E3F'; // на светлом сайдбаре
const SW = 1.7;

function svg(color, body) {
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="${color}" stroke-width="${SW}" stroke-linecap="round" stroke-linejoin="round">${body}</svg>\n`;
}

// Общая база "карточка" не используется — каждый значок самостоятельный
// простой пиктограмм, чтобы на 16px оставался читаемым.
const GLYPHS = {
	// --- бизнес-объекты ---
	catalog: '<rect x="5" y="4" width="3" height="3" rx="0.5"/><rect x="5" y="10.5" width="3" height="3" rx="0.5"/><rect x="5" y="17" width="3" height="3" rx="0.5"/>' +
		'<line x1="10.5" y1="5.5" x2="19" y2="5.5"/><line x1="10.5" y1="12" x2="19" y2="12"/><line x1="10.5" y1="18.5" x2="19" y2="18.5"/>',
	document: '<path d="M6.5 3h8l4 4v14h-12z"/><path d="M14.5 3v4h4"/><line x1="9" y1="12" x2="15" y2="12"/><line x1="9" y1="16" x2="15" y2="16"/>',
	documentJournal: '<path d="M5.5 6h8l3 3v11h-11z"/><path d="M13.5 6v3h3"/><line x1="8" y1="13" x2="13" y2="13"/><line x1="8" y1="16.5" x2="13" y2="16.5"/>' +
		'<path d="M8.5 3h8l3 3" opacity=".55"/>',
	enum: '<path d="M12 3.5 15 7 12 10.5 9 7Z"/><path d="M12 13.5 15 17 12 20.5 9 17Z"/><line x1="12" y1="10.5" x2="12" y2="13.5"/>',
	constant: '<line x1="6" y1="10" x2="18" y2="10"/><line x1="6" y1="14" x2="18" y2="14"/>',
	report: '<line x1="4" y1="21" x2="20" y2="21"/><rect x="6" y="14" width="3" height="7"/><rect x="10.5" y="9" width="3" height="12"/><rect x="15" y="5" width="3" height="16"/>',
	dataProcessor: '<circle cx="12" cy="12" r="3.4"/>' +
		[0, 60, 120, 180, 240, 300].map((a) => {
			const r1 = 6.2, r2 = 9;
			const rad = (a * Math.PI) / 180;
			const x1 = 12 + r1 * Math.cos(rad), y1 = 12 + r1 * Math.sin(rad);
			const x2 = 12 + r2 * Math.cos(rad), y2 = 12 + r2 * Math.sin(rad);
			return `<line x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}"/>`;
		}).join(''),
	chartsOfCharacteristicType: '<circle cx="12" cy="5" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="18" r="2"/>' +
		'<path d="M12 7v4M12 11 6 16M12 11l6 5"/>',
	chartsOfAccount: '<line x1="12" y1="4" x2="12" y2="20"/><line x1="5" y1="7" x2="19" y2="7"/><line x1="7.5" y1="12" x2="10.5" y2="12"/><line x1="13.5" y1="16" x2="16.5" y2="16"/>',
	chartsOfCalculationType: '<circle cx="7" cy="7" r="2.3"/><circle cx="17" cy="17" r="2.3"/><line x1="18" y1="6" x2="6" y2="18"/>',
	informationRegister: '<rect x="4.5" y="4.5" width="15" height="15" rx="1"/><line x1="4.5" y1="12" x2="19.5" y2="12"/><line x1="12" y1="4.5" x2="12" y2="19.5"/>',
	accumulationRegister: '<rect x="4.5" y="6.5" width="15" height="13" rx="1"/><line x1="4.5" y1="13" x2="19.5" y2="13"/><line x1="12" y1="6.5" x2="12" y2="19.5"/>' +
		'<path d="M9 4.5 12 1.5 15 4.5M12 2v3.5"/>',
	accountingRegister: '<rect x="4.5" y="4.5" width="15" height="15" rx="1"/><line x1="4.5" y1="9.5" x2="19.5" y2="9.5"/><line x1="4.5" y1="14.5" x2="19.5" y2="14.5"/><line x1="12" y1="4.5" x2="12" y2="19.5"/>',
	calculationRegister: '<rect x="4.5" y="4.5" width="12" height="12" rx="1"/><line x1="4.5" y1="10.5" x2="16.5" y2="10.5"/><line x1="10.5" y1="4.5" x2="10.5" y2="16.5"/>' +
		'<circle cx="17.5" cy="17.5" r="4.3"/><line x1="17.5" y1="17.5" x2="17.5" y2="14.7"/><line x1="17.5" y1="17.5" x2="19.6" y2="18.6"/>',
	businessProcess: '<circle cx="4.5" cy="12" r="2"/><path d="M6.5 12h4"/><rect x="10.5" y="9.5" width="5" height="5" rx="1" transform="rotate(45 13 12)"/><path d="M16 12h4"/><circle cx="19.5" cy="12" r="2"/>',
	task: '<rect x="4.5" y="4.5" width="15" height="15" rx="2.5"/><path d="M8 12.5 11 15.5 16.5 9"/>',
	externalDataSource: '<rect x="9" y="10" width="6" height="7" rx="1.5"/><line x1="10.5" y1="10" x2="10.5" y2="6"/><line x1="13.5" y1="10" x2="13.5" y2="6"/><path d="M12 17v3"/>',
	// --- "общие" разделы ---
	subsystem: '<rect x="4.5" y="4.5" width="7" height="7" rx="1"/><rect x="12.5" y="4.5" width="7" height="7" rx="1"/>' +
		'<rect x="4.5" y="12.5" width="7" height="7" rx="1"/><rect x="12.5" y="12.5" width="7" height="7" rx="1"/>',
	commonModule: '<path d="M9.5 4c-2 0-2.5 1-2.5 3v3c0 1.3-.5 2-2 2 1.5 0 2 .7 2 2v3c0 2 .5 3 2.5 3"/>' +
		'<path d="M14.5 4c2 0 2.5 1 2.5 3v3c0 1.3.5 2 2 2-1.5 0-2 .7-2 2v3c0 2-.5 3-2.5 3"/>',
	sessionParameter: '<line x1="4.5" y1="8" x2="19.5" y2="8"/><circle cx="9" cy="8" r="2"/>' +
		'<line x1="4.5" y1="16" x2="19.5" y2="16"/><circle cx="15" cy="16" r="2"/>',
	role: '<rect x="4" y="6" width="16" height="12" rx="2"/><circle cx="9" cy="12" r="2.3"/><line x1="13.5" y1="10" x2="18" y2="10"/><line x1="13.5" y1="14" x2="17" y2="14"/>',
	commonAttribute: '<path d="M4.5 12 11 5.5h8.5V14L13 20.5Z"/><circle cx="15.2" cy="9.2" r="1.4"/>',
	exchangePlan: '<path d="M5 9c0-2.8 2.2-5 5-5h5"/><path d="M13 1.5 15.5 4 13 6.5"/>' +
		'<path d="M19 15c0 2.8-2.2 5-5 5H9"/><path d="M11 12.5 8.5 15 11 17.5"/>',
	filterCriteria: '<path d="M4.5 5h15L14 12.5V19l-4 2v-8.5Z"/>',
	eventSubscription: '<path d="M13 3 6 13h5l-1 8 8-11h-5Z"/>',
	scheduledJob: '<circle cx="12" cy="12" r="8"/><line x1="12" y1="12" x2="12" y2="7"/><line x1="12" y1="12" x2="15.5" y2="14"/>',
	commonCommand: '<rect x="3.5" y="4.5" width="17" height="15" rx="1.5"/><path d="M7 9.5 10.5 12 7 14.5"/><line x1="12" y1="14.5" x2="16" y2="14.5"/>',
	commonForm: '<rect x="4" y="5" width="16" height="14" rx="1.5"/><line x1="4" y1="9" x2="20" y2="9"/><circle cx="6.6" cy="7" r=".6" fill="currentColor" stroke="none"/><circle cx="8.6" cy="7" r=".6" fill="currentColor" stroke="none"/>',
	commonTemplate: '<rect x="4" y="4" width="16" height="16" rx="1.5"/><line x1="4" y1="9" x2="20" y2="9"/><line x1="11" y1="9" x2="11" y2="20"/>',
	commonPicture: '<rect x="4" y="5" width="16" height="14" rx="1.5"/><circle cx="8.5" cy="9.5" r="1.6"/><path d="M4 17l5-5 4 3.5 3-3 4 4.5"/>',
	ws: '<circle cx="12" cy="12" r="8"/><ellipse cx="12" cy="12" rx="3.2" ry="8"/><line x1="4" y1="12" x2="20" y2="12"/>',
	http: '<circle cx="12" cy="18.5" r="1.6" fill="currentColor" stroke="none"/><path d="M8 15a5.7 5.7 0 0 1 8 0"/><path d="M5 11.7a10 10 0 0 1 14 0"/>',
	wsLink: '<rect x="3.5" y="9" width="8" height="6" rx="3" transform="rotate(-40 7.5 12)"/><rect x="12.5" y="9" width="8" height="6" rx="3" transform="rotate(-40 16.5 12)"/>',
	style: '<circle cx="12" cy="12" r="8"/><circle cx="9" cy="9.5" r="1.5" fill="currentColor" stroke="none"/>' +
		'<circle cx="15.5" cy="9.5" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="15.5" r="1.5" fill="currentColor" stroke="none"/>',
	common: '<path d="M12 3 20 7.5 12 12 4 7.5Z"/><path d="M4 12l8 4.5 8-4.5"/><path d="M4 16.5 12 21l8-4.5"/>',
	functionalOption: '<rect x="4" y="9" width="16" height="6" rx="3"/><circle cx="15" cy="12" r="3.6" fill="currentColor" stroke="none"/>',
	functionalOptionsParameter: '<rect x="4" y="5" width="13" height="4.5" rx="2.25"/><circle cx="12.5" cy="7.25" r="2.6" fill="currentColor" stroke="none"/>' +
		'<rect x="4" y="14.5" width="13" height="4.5" rx="2.25"/><circle cx="8.5" cy="16.75" r="2.6" fill="currentColor" stroke="none"/>',
	definedType: '<circle cx="9.5" cy="13" r="6"/><rect x="9.5" y="5" width="11" height="11" rx="2"/>',
	settingsStorage: '<rect x="4" y="4" width="16" height="16" rx="1.5"/><line x1="4" y1="11.3" x2="20" y2="11.3"/>' +
		'<line x1="9" y1="7.6" x2="15" y2="7.6"/><line x1="9" y1="15" x2="15" y2="15"/>',
	commandGroup: '<path d="M4 7.5h6l2 2h8v10H4Z"/><path d="M10.5 14 13 16l-2.5 2"/>',
	xdtoPackage: '<path d="M4 8 12 4 20 8 20 16 12 20 4 16Z"/><path d="M4 8 12 12 20 8M12 12v8"/>',
	styleItem: '<path d="M12 3c4 5 6 8.2 6 11a6 6 0 0 1-12 0c0-2.8 2-6 6-11Z"/>',
	language: '<line x1="6.5" y1="3" x2="6.5" y2="21"/><path d="M6.5 4.5h11l-2.7 3.2 2.7 3.2h-11Z"/>',
	interface: '<rect x="4" y="4" width="16" height="16" rx="1.5"/><line x1="10.5" y1="4" x2="10.5" y2="20"/>',
};

function writeSet(dir, color) {
	fs.mkdirSync(dir, { recursive: true });
	for (const [name, body] of Object.entries(GLYPHS)) {
		fs.writeFileSync(path.join(dir, `${name}.svg`), svg(color, body), 'utf8');
	}
}

const base = __dirname;
writeSet(path.join(base, 'dark'), DARK_COLOR);
writeSet(path.join(base, 'light'), LIGHT_COLOR);
console.log('Сгенерировано', Object.keys(GLYPHS).length, 'иконок x 2 темы в', base);
