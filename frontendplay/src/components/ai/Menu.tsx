import React from 'react';

export function Menu() {
  return (
    <aside className="flex flex-col gap-[32px] pt-[24px] pr-[24px] pb-[32px] pl-[24px] items-start justify-between w-[251px] h-[736px] relative bg-[#000000] overflow-hidden">
      {/* Top Section */}
      <section className="flex flex-col gap-[44px] items-start justify-start w-[203px] h-[496px] relative">
        {/* Profile */}
        <div className="flex flex-row gap-[12px] items-center justify-start w-[218px] h-[56px] relative">
          <div className="w-[56px] h-[56px] relative bg-[#14ae5c] rounded-[16px]" />
          <div className="flex flex-col items-start justify-center w-[150px] h-[41px] relative">
            <p className="text-[16px] font-700 text-left text-[#efefef] w-[150px] h-[22px]">Duck UI</p>
            <p className="text-[14px] font-400 text-left text-[#c0bfbd] w-[150px] h-[19px]">Duckui@demo.com</p>
          </div>
        </div>
        {/* Search */}
        <div className="flex flex-col gap-[10px] pt-[16px] pr-[16px] pb-[16px] pl-[16px] items-start justify-center w-[218px] h-[56px] relative bg-[#1f1f22] rounded-[16px]">
          <div className="flex flex-row gap-[16px] items-center justify-start w-[186px] h-[24px] relative">
            <div className="w-[24px] h-[24px] relative" />
            <p className="text-[16px] font-400 text-left text-[#efefef] w-[146px] h-[22px] relative">Search...</p>
          </div>
        </div>
        {/* List Items */}
        <div className="flex flex-col gap-[24px] items-start justify-start w-[218px] h-[296px] relative">
          {/* List Manu 1 */}
          <div className="flex flex-col gap-[10px] pt-[16px] pr-[16px] pb-[16px] pl-[16px] items-start justify-start w-[218px] h-[56px] relative rounded-[8px]">
            <div className="flex flex-row gap-[16px] items-center justify-start w-[186px] h-[24px] relative">
              <div className="w-[24px] h-[24px] relative" />
              <p className="text-[16px] font-400 text-left text-[#efefef] w-[83px] h-[22px] relative">Dashboard</p>
            </div>
          </div>
          {/* List Manu 2 */}
          <div className="flex flex-col gap-[10px] pt-[16px] pr-[16px] pb-[16px] pl-[16px] items-start justify-start w-[218px] h-[56px] relative rounded-[8px]">
            <div className="flex flex-row gap-[16px] items-center justify-start w-[186px] h-[24px] relative">
              <div className="w-[24px] h-[24px] relative overflow-hidden" />
              <p className="text-[16px] font-400 text-left text-[#efefef] w-[98px] h-[22px] relative">Ad Optimizer</p>
            </div>
          </div>
          {/* List Manu 3 */}
          <div className="flex flex-col gap-[10px] pt-[16px] pr-[16px] pb-[16px] pl-[16px] items-start justify-start w-[218px] h-[56px] relative rounded-[8px]">
            <div className="flex flex-row gap-[16px] items-center justify-start w-[186px] h-[24px] relative">
              <div className="w-[24px] h-[24px] relative bg-[#aff4c6]" />
              <p className="text-[16px] font-400 text-left text-[#efefef] w-[86px] h-[22px] relative">AI Assistant</p>
            </div>
          </div>
          {/* List Manu 4 */}
          <div className="flex flex-col gap-[10px] pt-[16px] pr-[16px] pb-[16px] pl-[16px] items-start justify-start w-[218px] h-[56px] relative rounded-[8px]">
            <div className="flex flex-row gap-[16px] items-center justify-start w-[186px] h-[24px] relative">
              <div className="w-[24px] h-[24px] relative rounded-[2px]" />
              <p className="text-[16px] font-400 text-left text-[#efefef] w-[66px] h-[22px] relative">Analytics</p>
            </div>
          </div>
          {/* List Manu 5 */}
          <div className="flex flex-col gap-[10px] pt-[16px] pr-[16px] pb-[16px] pl-[16px] items-start justify-start w-[218px] h-[56px] relative rounded-[8px]">
            <div className="flex flex-row gap-[16px] items-center justify-start w-[186px] h-[24px] relative">
              <div className="w-[24px] h-[24px] relative rounded-[0.5px]" />
              <p className="text-[16px] font-400 text-left text-[#efefef] w-[71px] h-[22px] relative">Inventory</p>
            </div>
          </div>
        </div>
      </section>
      {/* Bottom Section */}
      <section className="flex flex-col gap-[8px] items-start justify-start w-[203px] h-[56px] relative">
        <div className="flex flex-row gap-[8px] pt-[16px] pr-[84px] pb-[16px] pl-[20px] items-center justify-between w-[218px] h-[56px] relative rounded-[8px]">
          <div className="flex flex-row gap-[16px] items-center justify-start w-[124px] h-[24px] relative">
            <div className="w-[24px] h-[24px] relative" />
            <p className="text-[16px] font-400 text-left text-[#c0bfbd] w-[84px] h-[22px] relative">Light mode</p>
          </div>
          <div className="w-[56px] h-[32px] relative">
            <div className="w-[56px] h-[32px] relative bg-[#1f1f22] rounded-[16px]" />
            <div className="w-[28px] h-[28px] bg-[#aff4c6] rounded-[14px] shadow-[0_1px_3px_0_rgba(0,0,0,0.1),0_1px_2px_0_rgba(0,0,0,0.1),0_2px_4px_0_rgba(0,0,0,0.1)] absolute top-[2px] left-[2px]" />
            <div className="w-[24px] h-[24px] relative">
              <div className="w-[10px] h-[10px] relative" />
              <div className="w-[0px] h-[20px] absolute top-0 left-[10px]" />
              <div className="w-[20px] h-[0px] absolute top-[10px] left-0 rotate-90" />
              <div className="w-[14px] h-[14px] rotate-45 absolute top-[5px] left-[5px]" />
              <div className="w-[14px] h-[14px] -rotate-135 absolute top-[5px] left-[5px]" />
            </div>
          </div>
        </div>
      </section>
    </aside>
  );
}
