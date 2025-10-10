import React from "react";
import Icons_8877ca from "/src/assets/icons/icons-8877ca.svg?url";
import Icons_faae42 from "/src/assets/icons/icons-faae42.svg?url";
import Zap_cbadb5 from "/src/assets/icons/zap-cbadb5.svg?url";
import Chat_bubble_8a6b37 from "/src/assets/icons/chat-bubble-8a6b37.svg?url";
import Icons_da553d from "/src/assets/icons/icons-da553d.svg?url";
import Settings_a24f08 from "/src/assets/icons/settings-a24f08.svg?url";
import Icons8877ca from "/src/assets/icons/icons-8877ca.svg?url";

export function Menu() {
  return (
    <div className="flex flex-col gap-[32px] pt-[24px] pr-[24px] pb-[32px] pl-[24px] items-start justify-between w-[251px] h-[736px] relative bg-[#000000] overflow-hidden z-[0]">
      <div className="flex flex-col gap-[44px] items-start justify-start w-[203px] h-[496px] relative z-[0]">
        <div className="flex flex-row gap-[12px] items-center justify-start w-[218px] h-[56px] relative z-[0]">
          <div className="w-[56px] h-[56px] relative bg-[#4fd7a2] rounded-[16px] z-[0]" />
          <div className="flex flex-col items-start justify-center w-[150px] h-[41px] relative z-[1]">
            <div className="w-[150px] h-[22px] relative text-[#f8f8f8] text-left text-[16px] font-[700] leading-[21.79px] tracking-[0.0px] font-['Open_Sans'] z-[0]">
              Duck UI
            </div>
            <div className="w-[150px] h-[19px] relative text-[#e1e0df] text-left text-[14px] font-[400] leading-[19.07px] tracking-[0.0px] font-['Open_Sans'] z-[1]">
              Duckui@demo.com
            </div>
          </div>
        </div>
        <div className="flex flex-col gap-[10px] pt-[16px] pr-[16px] pb-[16px] pl-[16px] items-start justify-center w-[218px] h-[56px] relative bg-[#626266] rounded-[16px] z-[1]">
          <div className="flex flex-row gap-[16px] items-center justify-start w-[186px] h-[24px] relative z-[0]">
            <div className="w-[24px] h-[24px] relative z-[0]">
              <div className="w-[14px] h-[14px] relative z-[0]" />
              <div className="w-[3.5px] h-[3.5px] relative rotate-[0.79deg] z-[1]" />
            </div>
            <div className="w-[146px] h-[22px] relative text-[#f8f8f8] text-left text-[16px] font-[400] leading-[22.4px] tracking-[0.0px] font-['Open_Sans'] z-[1]">
              Search...
            </div>
          </div>
        </div>
        <div className="flex flex-col gap-[24px] items-start justify-start w-[218px] h-[296px] relative z-[2]">
          <div className="flex flex-col gap-[10px] pt-[16px] pr-[16px] pb-[16px] pl-[16px] items-start justify-start w-[218px] h-[56px] relative rounded-[8px] z-[0]">
            <div className="flex flex-row gap-[16px] items-center justify-start w-[186px] h-[24px] relative z-[0]">
              <div className="w-[24px] h-[24px] relative z-[0]">
                <img
                  src={Icons_faae42}
                  alt=""
                  aria-hidden="true"
                  width={24}
                  height={24}
                  className="inline-block align-middle w-[24px] h-[24px]"
                />
              </div>
              <div className="w-[83px] h-[22px] relative text-[#f8f8f8] text-left text-[16px] font-[400] leading-[22.4px] tracking-[0.0px] font-['Open_Sans'] z-[1]">
                Dashboard
              </div>
            </div>
          </div>
          <div className="flex flex-col gap-[10px] pt-[16px] pr-[16px] pb-[16px] pl-[16px] items-start justify-start w-[218px] h-[56px] relative rounded-[8px] z-[1]">
            <div className="flex flex-row gap-[16px] items-center justify-start w-[186px] h-[24px] relative z-[0]">
              <div className="w-[24px] h-[24px] relative overflow-hidden z-[0]">
                <img
                  src={Zap_cbadb5}
                  alt=""
                  aria-hidden="true"
                  width={24}
                  height={24}
                  className="inline-block align-middle w-[24px] h-[24px]"
                />
              </div>
              <div className="w-[98px] h-[22px] relative text-[#f8f8f8] text-left text-[16px] font-[400] leading-[22.4px] tracking-[0.0px] font-['Open_Sans'] z-[1]">
                Ad Optimizer
              </div>
            </div>
          </div>
          <div className="flex flex-col gap-[10px] pt-[16px] pr-[16px] pb-[16px] pl-[16px] items-start justify-start w-[218px] h-[56px] relative rounded-[8px] z-[2]">
            <div className="flex flex-row gap-[16px] items-center justify-start w-[186px] h-[24px] relative z-[0]">
              <div className="w-[24px] h-[24px] relative z-[0]">
                <img
                  src={Chat_bubble_8a6b37}
                  alt=""
                  aria-hidden="true"
                  width={24}
                  height={24}
                  className="inline-block align-middle w-[24px] h-[24px]"
                />
              </div>
              <div className="w-[86px] h-[22px] relative text-[#f8f8f8] text-left text-[16px] font-[400] leading-[22.4px] tracking-[0.0px] font-['Open_Sans'] z-[1]">
                AI Assistant
              </div>
            </div>
          </div>
          <div className="flex flex-col gap-[10px] pt-[16px] pr-[16px] pb-[16px] pl-[16px] items-start justify-start w-[218px] h-[56px] relative rounded-[8px] z-[3]">
            <div className="flex flex-row gap-[16px] items-center justify-start w-[186px] h-[24px] relative z-[0]">
              <div className="w-[24px] h-[24px] relative z-[0]">
                <img
                  src={Icons_da553d}
                  alt=""
                  aria-hidden="true"
                  width={24}
                  height={24}
                  className="inline-block align-middle w-[24px] h-[24px]"
                />
              </div>
              <div className="w-[66px] h-[22px] relative text-[#f8f8f8] text-left text-[16px] font-[400] leading-[22.4px] tracking-[0.0px] font-['Open_Sans'] z-[1]">
                Analytics
              </div>
            </div>
          </div>
        </div>
      </div>
      <div className="flex flex-col gap-[8px] items-start justify-start w-[203px] h-[56px] relative z-[1]">
        <div className="flex flex-col gap-[10px] pt-[16px] pr-[16px] pb-[16px] pl-[16px] items-start justify-start w-[218px] h-[56px] relative rounded-[8px] z-[0]">
          <div className="flex flex-row gap-[16px] items-center justify-start w-[186px] h-[24px] relative z-[0]">
            <div className="w-[24px] h-[24px] relative z-[0]">
              <img
                src={Settings_a24f08}
                alt=""
                aria-hidden="true"
                width={24}
                height={24}
                className="inline-block align-middle w-[24px] h-[24px]"
              />
            </div>
            <div className="w-[60px] h-[22px] relative text-[#f8f8f8] text-left text-[16px] font-[400] leading-[22.4px] tracking-[0.0px] font-['Open_Sans'] z-[1]">
              Settings
            </div>
          </div>
        </div>
      </div>
      <img
        src={Icons8877ca}
        alt=""
        aria-hidden="true"
        width={24}
        height={24}
        className="inline-block align-middle w-[24px] h-[24px]"
      />
    </div>
  );
}
