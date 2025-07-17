import React from "react";
import clsx from "clsx";

export const Card = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={clsx(
      "rounded-xl border border-gray-300 bg-white shadow-sm",
      className
    )}
    {...props}
  />
);

export const CardHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={clsx("p-4 border-b border-gray-200", className)} {...props} />
);

export const CardTitle = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLHeadingElement>) => (
  <h2 className={clsx("text-lg font-semibold", className)} {...props} />
);

export const CardContent = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={clsx("p-4", className)} {...props} />
);
