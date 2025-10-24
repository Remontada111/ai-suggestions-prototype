"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Input = void 0;
const jsx_runtime_1 = require("react/jsx-runtime");
const react_1 = __importDefault(require("react"));
const clsx_1 = __importDefault(require("clsx"));
exports.Input = react_1.default.forwardRef(({ className, ...props }, ref) => ((0, jsx_runtime_1.jsx)("input", { ref: ref, className: (0, clsx_1.default)("w-full rounded-md border border-gray-300 px-3 py-2 text-sm outline-none", "focus:border-blue-600 focus:ring-2 focus:ring-blue-500", className), ...props })));
exports.Input.displayName = "Input";
exports.default = exports.Input;
//# sourceMappingURL=input.js.map