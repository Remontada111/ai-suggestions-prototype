"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CardContent = exports.CardTitle = exports.CardHeader = exports.Card = void 0;
const jsx_runtime_1 = require("react/jsx-runtime");
const clsx_1 = __importDefault(require("clsx"));
const Card = ({ className, ...props }) => ((0, jsx_runtime_1.jsx)("div", { className: (0, clsx_1.default)("rounded-xl border border-gray-300 bg-white shadow-sm", className), ...props }));
exports.Card = Card;
const CardHeader = ({ className, ...props }) => ((0, jsx_runtime_1.jsx)("div", { className: (0, clsx_1.default)("p-4 border-b border-gray-200", className), ...props }));
exports.CardHeader = CardHeader;
const CardTitle = ({ className, ...props }) => ((0, jsx_runtime_1.jsx)("h2", { className: (0, clsx_1.default)("text-lg font-semibold", className), ...props }));
exports.CardTitle = CardTitle;
const CardContent = ({ className, ...props }) => ((0, jsx_runtime_1.jsx)("div", { className: (0, clsx_1.default)("p-4", className), ...props }));
exports.CardContent = CardContent;
//# sourceMappingURL=card.js.map