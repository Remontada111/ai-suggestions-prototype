"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Button = void 0;
const jsx_runtime_1 = require("react/jsx-runtime");
const react_1 = __importDefault(require("react"));
const clsx_1 = __importDefault(require("clsx"));
exports.Button = react_1.default.forwardRef(({ className, variant = "default", ...props }, ref) => ((0, jsx_runtime_1.jsx)("button", { ref: ref, className: (0, clsx_1.default)("px-4 py-2 rounded-md text-sm font-medium transition", {
        default: "bg-gray-200 text-gray-900 hover:bg-gray-300",
        primary: "bg-blue-600 text-white hover:bg-blue-700",
        destructive: "bg-red-600 text-white hover:bg-red-700",
    }[variant], className), ...props })));
exports.Button.displayName = "Button";
exports.default = exports.Button;
//# sourceMappingURL=button.js.map