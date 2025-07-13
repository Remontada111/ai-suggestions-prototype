import {
  BarChart3Icon,
  HomeIcon,
  MessageSquareIcon,
  SearchIcon,
  SettingsIcon,
  ZapIcon,
} from "lucide-react";
import React from "react";
// Update the import path below to the correct location of your Button component.
// For example, if Button is in 'src/components/Button.tsx', use:
import { Button } from "./button";
// If you have a different path, adjust accordingly.

const navigationItems = [
  {
    icon: HomeIcon,
    label: "Dashboard",
    href: "#",
  },
  {
    icon: ZapIcon,
    label: "Ad Optimizer",
    href: "#",
  },
  {
    icon: MessageSquareIcon,
    label: "AI Assistant",
    href: "#",
  },
  {
    icon: BarChart3Icon,
    label: "Analytics",
    href: "#",
  },
];

export const Menu: React.FC = () => {
  return (
    <nav
      className="inline-flex flex-col h-[1024px] items-start justify-between pt-6 pb-8 px-6 bg-gray-shadesdark-gray border-r border-gray-shadesdark-shade"
      data-model-id="429:260"
    >
      <div className="flex flex-col items-start gap-11 w-full">
        <header className="inline-flex items-center gap-3">
          <div className="w-14 h-14 bg-[#14ae5c] rounded-2xl" />
          <div className="inline-flex flex-col items-start justify-center">
            <h1 className="w-[150px] mt-[-1.00px] [font-family:'Open_Sans',Helvetica] font-bold text-gray-shadeslight-gray-2 text-base tracking-[0] leading-[normal]">
              Duck UI
            </h1>
            <p className="w-[150px] [font-family:'Open_Sans',Helvetica] font-normal text-gray-shadeslight-gray-3 text-sm tracking-[0] leading-[normal]">
              Duckui@demo.com
            </p>
          </div>
        </header>

        <div className="flex flex-col w-[218px] items-start justify-center gap-2.5 p-4 bg-gray-shadesdark-shade rounded-2xl">
          <div className="flex w-[186px] h-6 items-center gap-4">
            <SearchIcon className="w-6 h-6 text-gray-shadeslight-gray-2" />
            <span className="w-[146px] [font-family:'Open_Sans',Helvetica] font-normal text-gray-shadeslight-gray-2 text-base tracking-[0] leading-[22.4px]">
              SearchIcon...
            </span>
          </div>
        </div>

        <nav className="gap-6 inline-flex flex-col items-start">
          {navigationItems.map((item, index) => (
            <Button
              key={index}
              variant="ghost"
              className="gap-2.5 p-4 rounded-lg inline-flex flex-col items-start h-auto hover:bg-gray-shadesdark-shade"
            >
              <div className="flex w-[186px] h-6 items-center gap-4">
                <item.icon className="w-6 h-6 text-gray-shadeslight-gray-2" />
                <span className="w-fit [font-family:'Open_Sans',Helvetica] font-normal text-gray-shadeslight-gray-2 text-base tracking-[0] leading-[22.4px] whitespace-nowrap">
                  {item.label}
                </span>
              </div>
            </Button>
          ))}
        </nav>
      </div>

      <div className="flex flex-col items-start gap-2 w-full">
        <Button
          variant="ghost"
          className="gap-2.5 p-4 rounded-lg inline-flex flex-col items-start h-auto hover:bg-gray-shadesdark-shade"
        >
          <div className="flex w-[186px] h-6 items-center gap-4">
            <SettingsIcon className="w-6 h-6 text-gray-shadeslight-gray-2" />
            <span className="w-fit [font-family:'Open_Sans',Helvetica] font-normal text-gray-shadeslight-gray-2 text-base tracking-[0] leading-[22.4px] whitespace-nowrap">
              SettingsIcon
            </span>
          </div>
        </Button>
      </div>
    </nav>
  );
};
