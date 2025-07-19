import { jsx as _jsx } from "react/jsx-runtime";
import clsx from "clsx";
export const Card = ({ className, ...props }) => (_jsx("div", { className: clsx("rounded-xl border border-gray-300 bg-white shadow-sm", className), ...props }));
export const CardHeader = ({ className, ...props }) => (_jsx("div", { className: clsx("p-4 border-b border-gray-200", className), ...props }));
export const CardTitle = ({ className, ...props }) => (_jsx("h2", { className: clsx("text-lg font-semibold", className), ...props }));
export const CardContent = ({ className, ...props }) => (_jsx("div", { className: clsx("p-4", className), ...props }));
//# sourceMappingURL=card.js.map