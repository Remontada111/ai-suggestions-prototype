import { jsx as _jsx } from "react/jsx-runtime";
import React from "react";
import clsx from "clsx";
export const Input = React.forwardRef(({ className, ...props }, ref) => (_jsx("input", { ref: ref, className: clsx("w-full rounded-md border border-gray-300 px-3 py-2 text-sm outline-none", "focus:border-blue-600 focus:ring-2 focus:ring-blue-500", className), ...props })));
Input.displayName = "Input";
export default Input;
//# sourceMappingURL=input.js.map