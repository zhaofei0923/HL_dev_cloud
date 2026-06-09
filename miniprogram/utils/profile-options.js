"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.regionValueText = exports.regionPickerText = exports.heightPickerText = exports.agePickerText = exports.pickerText = exports.OCCUPATION_OPTIONS = exports.INCOME_OPTIONS = exports.EDUCATION_OPTIONS = exports.HEIGHT_OPTIONS = exports.AGE_OPTIONS = void 0;
function rangeStrings(start, end) {
    const values = [];
    for (let value = start; value <= end; value += 1)
        values.push(String(value));
    return values;
}
function cleanText(value) {
    return String(value || '').trim();
}
function hasUnit(value, unit) {
    return value.indexOf(unit) >= 0;
}
exports.AGE_OPTIONS = rangeStrings(18, 60);
exports.HEIGHT_OPTIONS = rangeStrings(145, 210);
exports.EDUCATION_OPTIONS = ['高中/中专', '大专', '本科', '硕士', '博士', '其他'];
exports.INCOME_OPTIONS = ['10万以下', '10-20万', '20-30万', '30-50万', '50-100万', '100万以上'];
exports.OCCUPATION_OPTIONS = [
    '互联网/科技',
    '金融',
    '教育/培训',
    '医疗/健康',
    '法律/咨询',
    '文化传媒',
    '设计/艺术',
    '公务员/事业单位',
    '企业管理',
    '创业/个体',
    '自由职业',
    '其他'
];
function pickerText(value, placeholder) {
    return cleanText(value) || placeholder;
}
exports.pickerText = pickerText;
function agePickerText(value) {
    const text = cleanText(value);
    if (!text)
        return '请选择年龄';
    return hasUnit(text, '岁') ? text : `${text} 岁`;
}
exports.agePickerText = agePickerText;
function heightPickerText(value) {
    const text = cleanText(value);
    if (!text)
        return '请选择身高';
    return hasUnit(text, 'cm') ? text : `${text}cm`;
}
exports.heightPickerText = heightPickerText;
function regionPickerText(value, placeholder) {
    return cleanText(value) || placeholder;
}
exports.regionPickerText = regionPickerText;
function regionValueText(region) {
    if (!Array.isArray(region))
        return '';
    const province = cleanText(region[0]);
    const city = cleanText(region[1]);
    return [province, city].filter(Boolean).join(' ');
}
exports.regionValueText = regionValueText;
