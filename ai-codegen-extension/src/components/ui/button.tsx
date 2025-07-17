import React from "react";
import clsx from "clsx";

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "default" | "primary" | "destructive";
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "default", ...props }, ref) => (
    <button
      ref={ref}
      className={clsx(
        "px-4 py-2 rounded-md text-sm font-medium transition",
        {
          default: "bg-gray-200 text-gray-900 hover:bg-gray-300",
          primary: "bg-blue-600 text-white hover:bg-blue-700",
          destructive: "bg-red-600 text-white hover:bg-red-700",
        }[variant],
        className
      )}
      {...props}
    />
  )
);
Button.displayName = "Button";
export default Button;
