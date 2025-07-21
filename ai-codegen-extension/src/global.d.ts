// src/global.d.ts
declare module '@/components/ui/button' {
  import { FC, ComponentProps } from 'react';
  export const Button: FC<ComponentProps<'button'>>; 
  // or: export const Button: any;
}
declare module '@/components/ui/card' {
  import { FC, ComponentProps } from 'react';
  export const Card: FC<ComponentProps<'div'>>;
  export const CardContent: FC<ComponentProps<'div'>>;
  export const CardHeader: FC<ComponentProps<'div'>>;
  export const CardTitle: FC<ComponentProps<'h2'>>;
}
