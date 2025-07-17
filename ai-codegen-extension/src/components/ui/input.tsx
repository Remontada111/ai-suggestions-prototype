import React from "react";
import clsx from "clsx";

export interface InputProps
  extends React.InputHTMLAttributes<HTMLInputElement> {}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={clsx(
        "w-full rounded-md border border-gray-300 px-3 py-2 text-sm outline-none",
        "focus:border-blue-600 focus:ring-2 focus:ring-blue-500",
        className
      )}
      {...props}
    />
  )
);
Input.displayName = "Input";
export default Input;
