import { forwardRef, ButtonHTMLAttributes } from "react";
import clsx from "clsx";

type Variant = "default" | "primary" | "destructive";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
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
