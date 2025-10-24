import clsx from "clsx";
import { HTMLAttributes } from "react";

type DivProps = HTMLAttributes<HTMLDivElement>;

export const Card = ({ className, ...props }: DivProps) => (
  <div
    className={clsx("rounded-xl border border-gray-300 bg-white shadow-sm", className)}
    {...props}
  />
);

export const CardHeader = ({ className, ...props }: DivProps) => (
  <div className={clsx("p-4 border-b border-gray-200", className)} {...props} />
);

export const CardTitle = ({ className, ...props }: DivProps) => (
  <h2 className={clsx("text-lg font-semibold", className)} {...props} />
);

export const CardContent = ({ className, ...props }: DivProps) => (
  <div className={clsx("p-4", className)} {...props} />
);
