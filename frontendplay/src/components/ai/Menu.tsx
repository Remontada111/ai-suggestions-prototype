import React from "react";
import AvatarIcon from "/src/assets/icons/avatar-c0aa97.svg?url";
import Icons8877ca from "/src/assets/icons/icons-8877ca.svg?url";
import IconsFaae42 from "/src/assets/icons/icons-faae42.svg?url";
import ZapIcon from "/src/assets/icons/zap-cbadb5.svg?url";
import ChatBubbleIcon from "/src/assets/icons/chat-bubble-8a6b37.svg?url";
import IconsDa553d from "/src/assets/icons/icons-da553d.svg?url";
import SettingsIcon from "/src/assets/icons/settings-a24f08.svg?url";

export default function Menu() {
  return (
    <div className="w-[251px] h-[736px] relative overflow-hidden flex flex-col gap-[32px] pt-[24px] pr-[24px] pb-[32px] pl-[24px] items-start justify-between z-[0] font-['Open_Sans']">
      <div className="w-[218px] h-[496px] relative flex flex-col gap-[44px] items-start justify-start z-[0]">
        <div className="w-[218px] h-[56px] relative flex flex-row gap-[12px] items-center justify-start z-[0]">
          <div className="w-[56px] h-[56px] relative rounded-[16px] z-[0]">
            <img
              src={AvatarIcon}
              alt=""
              aria-hidden="true"
              width={56}
              height={56}
              className="inline-block align-middle w-[56px] h-[56px]"
            />
          </div>
          <div className="w-[150px] h-[41px] relative flex flex-col items-start justify-center z-[1]">
            <div className="w-[59.19px] h-[12.31px] relative text-[#efefef] text-[16px] leading-[21.79px] tracking-[0px] font-[700] text-left z-[0]">
              Duck UI
            </div>
            <div className="w-[124.58px] h-[11.9px] relative text-[#c0bfbd] text-[14px] leading-[19.07px] tracking-[0px] font-[400] text-left z-[1]">
              Duckui@demo.com
            </div>
          </div>
        </div>
        <div className="w-[218px] h-[56px] relative flex flex-col gap-[10px] pt-[16px] pr-[16px] pb-[16px] pl-[16px] items-start justify-center rounded-[16px] z-[1]">
          <div className="w-[186px] h-[24px] relative flex flex-row gap-[16px] items-center justify-start z-[0]">
            <div className="w-[24px] h-[24px] relative z-[0]">
              <img
                src={Icons8877ca}
                alt=""
                aria-hidden="true"
                width={24}
                height={24}
                className="inline-block align-middle w-[24px] h-[24px]"
              />
            </div>
            <div className="w-[61.3px] h-[12.38px] relative text-[#efefef] text-[16px] leading-[22.4px] tracking-[0px] font-[400] text-left z-[1]">
              Search...
            </div>
          </div>
        </div>
        <div className="w-[218px] h-[296px] relative flex flex-col gap-[24px] items-start justify-start z-[2]">
          <div className="w-[218px] h-[56px] relative flex flex-col gap-[10px] pt-[16px] pr-[16px] pb-[16px] pl-[16px] items-start justify-start rounded-[8px] z-[0]">
            <div className="w-[186px] h-[24px] relative flex flex-row gap-[16px] items-center justify-start z-[0]">
              <div className="w-[24px] h-[24px] relative z-[0]">
                <img
                  src={IconsFaae42}
                  alt=""
                  aria-hidden="true"
                  width={24}
                  height={24}
                  className="inline-block align-middle w-[24px] h-[24px]"
                />
              </div>
              <div className="w-[79.65px] h-[12.31px] relative text-[#efefef] text-[16px] leading-[22.4px] tracking-[0px] font-[400] text-left z-[1]">
                Dashboard
              </div>
            </div>
          </div>
          <div className="w-[218px] h-[56px] relative flex flex-col gap-[10px] pt-[16px] pr-[16px] pb-[16px] pl-[16px] items-start justify-start rounded-[8px] z-[1]">
            <div className="w-[186px] h-[24px] relative flex flex-row gap-[16px] items-center justify-start z-[0]">
              <div className="w-[24px] h-[24px] relative overflow-hidden z-[0]">
                <img
                  src={ZapIcon}
                  alt=""
                  aria-hidden="true"
                  width={24}
                  height={24}
                  className="inline-block align-middle w-[24px] h-[24px]"
                />
              </div>
              <div className="w-[97.72px] h-[15.98px] relative text-[#efefef] text-[16px] leading-[22.4px] tracking-[0px] font-[400] text-left z-[1]">
                Ad Optimizer
              </div>
            </div>
          </div>
          <div className="w-[218px] h-[56px] relative flex flex-col gap-[10px] pt-[16px] pr-[16px] pb-[16px] pl-[16px] items-start justify-start rounded-[8px] z-[2]">
            <div className="w-[186px] h-[24px] relative flex flex-row gap-[16px] items-center justify-start z-[0]">
              <div className="w-[24px] h-[24px] relative z-[0]">
                <img
                  src={ChatBubbleIcon}
                  alt=""
                  aria-hidden="true"
                  width={24}
                  height={24}
                  className="inline-block align-middle w-[24px] h-[24px]"
                />
              </div>
              <div className="w-[85.54px] h-[11.92px] relative text-[#efefef] text-[16px] leading-[22.4px] tracking-[0px] font-[400] text-left z-[1]">
                AI Assistant
              </div>
            </div>
          </div>
          <div className="w-[218px] h-[56px] relative flex flex-col gap-[10px] pt-[16px] pr-[16px] pb-[16px] pl-[16px] items-start justify-start rounded-[8px] z-[3]">
            <div className="w-[186px] h-[24px] relative flex flex-row gap-[16px] items-center justify-start z-[0]">
              <div className="w-[24px] h-[24px] relative z-[0]">
                <img
                  src={IconsDa553d}
                  alt=""
                  aria-hidden="true"
                  width={24}
                  height={24}
                  className="inline-block align-middle w-[24px] h-[24px]"
                />
              </div>
              <div className="w-[65.22px] h-[16.01px] relative text-[#efefef] text-[16px] leading-[22.4px] tracking-[0px] font-[400] text-left z-[1]">
                Analytics
              </div>
            </div>
          </div>
        </div>
      </div>
      <div className="w-[218px] h-[56px] relative flex flex-col gap-[8px] items-start justify-start z-[1]">
        <div className="w-[218px] h-[56px] relative flex flex-col gap-[10px] pt-[16px] pr-[16px] pb-[16px] pl-[16px] items-start justify-start rounded-[8px] z-[0]">
          <div className="w-[186px] h-[24px] relative flex flex-row gap-[16px] items-center justify-start z-[0]">
            <div className="w-[24px] h-[24px] relative z-[0]">
              <img
                src={SettingsIcon}
                alt=""
                aria-hidden="true"
                width={24}
                height={24}
                className="inline-block align-middle w-[24px] h-[24px]"
              />
            </div>
            <div className="w-[57.8px] h-[15.61px] relative text-[#efefef] text-[16px] leading-[22.4px] tracking-[0px] font-[400] text-left z-[1]">
              Settings
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
