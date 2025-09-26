import React from 'react';

export function Menu() {
  return (
    <aside className="flex flex-col gap-8 pt-6 pr-6 pb-8 pl-6 items-start justify-between w-[251px] h-[736px] relative bg-black border border-black overflow-hidden">
      {/* Top Section */}
      <section className="flex flex-col gap-11 items-start justify-start w-[203px] h-[496px] relative">
        {/* Profile */}
        <div className="flex flex-row gap-3 items-center justify-start w-[218px] h-[56px] relative">
          <div className="w-[56px] h-[56px] relative bg-[#14ae5c] rounded-[16px]" />
          <div className="flex flex-col items-start justify-center w-[150px] h-[41px] relative">
            <p className="text-[16px] font-bold text-[#efefef] text-left leading-[21.79px]">Duck UI</p>
            <p className="text-[14px] font-normal text-[#c0bfbd] text-left leading-[19.07px]">Duckui@demo.com</p>
          </div>
        </div>

        {/* Search */}
        <div className="flex flex-col gap-[10px] pt-4 pr-4 pb-4 pl-4 items-start justify-center w-[218px] h-[56px] relative bg-[#1f1f22] rounded-[16px]">
          <div className="flex flex-row gap-4 items-center justify-start w-[186px] h-[24px] relative">
            <div className="w-[24px] h-[24px] relative">
              <div className="w-[14px] h-[14px] relative -[1.5px] -[#aff4c6] rounded-none" />
              <div className="w-[3.5px] h-[3.5px] -[1.5px] -[#aff4c6] rotate-[45deg] absolute top-[5.25px] left-[11.5px]" />
            </div>
            <p className="text-[16px] font-normal text-[#efefef] text-left leading-[22.4px] w-[146px] h-[22px] relative">Search...</p>
          </div>
        </div>

        {/* List Items */}
        <div className="flex flex-col gap-6 items-start justify-start w-[218px] h-[296px] relative">
          {/* List Manu 1 */}
          <div className="flex flex-col gap-[10px] pt-4 pr-4 pb-4 pl-4 items-start justify-start w-[218px] h-[56px] relative rounded-[8px]">
            <div className="flex flex-row gap-4 items-center justify-start w-[186px] h-[24px] relative">
              <div className="w-[24px] h-[24px] relative">
                <div className="w-[18px] h-[19px] relative -[1.5px] -[#aff4c6] rounded-none" />
              </div>
              <p className="text-[16px] font-normal text-[#efefef] text-left leading-[22.4px] w-[83px] h-[22px] relative">Dashboard</p>
            </div>
          </div>

          {/* List Manu 2 */}
          <div className="flex flex-col gap-[10px] pt-4 pr-4 pb-4 pl-4 items-start justify-start w-[218px] h-[56px] relative rounded-[8px]">
            <div className="flex flex-row gap-4 items-center justify-start w-[186px] h-[24px] relative">
              <div className="w-[24px] h-[24px] relative overflow-hidden">
                <div className="w-[18px] h-[20px] relative -[1.5px] -[#aff4c6] rounded-none" />
              </div>
              <p className="text-[16px] font-normal text-[#efefef] text-left leading-[22.4px] w-[98px] h-[22px] relative">Ad Optimizer</p>
            </div>
          </div>

          {/* List Manu 3 */}
          <div className="flex flex-col gap-[10px] pt-4 pr-4 pb-4 pl-4 items-start justify-start w-[218px] h-[56px] relative rounded-[8px]">
            <div className="flex flex-row gap-4 items-center justify-start w-[186px] h-[24px] relative">
              <div className="w-[24px] h-[24px] relative">
                <div className="w-[20px] h-[20px] relative bg-[#aff4c6] rounded-none" />
              </div>
              <p className="text-[16px] font-normal text-[#efefef] text-left leading-[22.4px] w-[86px] h-[22px] relative">AI Assistant</p>
            </div>
          </div>

          {/* List Manu 4 */}
          <div className="flex flex-col gap-[10px] pt-4 pr-4 pb-4 pl-4 items-start justify-start w-[218px] h-[56px] relative rounded-[8px]">
            <div className="flex flex-row gap-4 items-center justify-start w-[186px] h-[24px] relative">
              <div className="w-[24px] h-[24px] relative">
                <div className="w-[20px] h-[20px] relative -[1.5px] -[#c8bcf6] rounded-[2px]" />
                <div className="w-[6.5px] h-[0px] -[1.5px] -[#c8bcf6] rounded-[0.5px] absolute top-[7px] left-[6px]" />
              </div>
              <p className="text-[16px] font-normal text-[#efefef] text-left leading-[22.4px] w-[66px] h-[22px] relative">Analytics</p>
            </div>
          </div>

          {/* List Manu 5 */}
          <div className="flex flex-col gap-[10px] pt-4 pr-4 pb-4 pl-4 items-start justify-start w-[218px] h-[56px] relative rounded-[8px]">
            <div className="flex flex-row gap-4 items-center justify-start w-[186px] h-[24px] relative">
              <div className="w-[24px] h-[24px] relative">
                <div className="w-[20px] h-[20px] relative -[1.5px] -[#aff4c6] rounded-[0.5px]" />
                <div className="w-[8px] h-[8px] -[1.5px] -[#aff4c6] rounded-[0.5px] absolute top-[6px] left-[12px]" />
              </div>
              <p className="text-[16px] font-normal text-[#efefef] text-left leading-[22.4px] w-[71px] h-[22px] relative">Inventory</p>
            </div>
          </div>
        </div>
      </section>

      {/* Bottom Section */}
      <section className="flex flex-col gap-2 items-start justify-start w-[203px] h-[56px] relative">
        <div className="flex flex-col gap-[10px] pt-4 pr-4 pb-4 pl-4 items-start justify-center w-[218px] h-[56px] relative rounded-[8px]">
          <div className="flex flex-row gap-4 items-center justify-start w-[186px] h-[24px] relative">
            <div className="w-[24px] h-[24px] relative">
              <div className="w-[20.1px] h-[20px] relative bg-[#aff4c6] rounded-none" />
            </div>
            <p className="text-[16px] font-normal text-[#efefef] text-left leading-[22.4px] w-[60px] h-[22px] relative">Settings</p>
          </div>
        </div>
      </section>

      {/* Light/Dark Control */}
      <section className="flex flex-row gap-2 pt-4 pr-21 pb-4 pl-5 items-center justify-between w-[218px] h-[56px] relative rounded-[8px]">
        <div className="flex flex-row gap-4 items-center justify-start w-[124px] h-[24px] relative">
          <div className="w-[24px] h-[24px] relative">
            <div className="w-[10px] h-[10px] relative -[1.5px] -[#aff4c6] rounded-none" />
            <div className="w-[20px] h-[0px] -[1.5px] -[#aff4c6] absolute top-[7px] left-[2px]" />
            <div className="w-[20px] h-[0px] -[1.5px] -[#aff4c6] rotate-[90deg] absolute top-[2px] left-[7px]" />
            <div className="w-[14.14px] h-[14.14px] -[1.5px] -[#aff4c6] rotate-45 absolute top-[7px] left-[7px]" />
            <div className="w-[14.14px] h-[14.14px] -[1.5px] -[#aff4c6] -rotate-45 absolute top-[7px] left-[7px]" />
          </div>
          <p className="text-[16px] font-normal text-[#c0bfbd] text-left leading-[22.4px] w-[84px] h-[22px] relative">Light mode</p>
        </div>

        <div className="w-[56px] h-[32px] relative flex items-center justify-start">
          <div className="w-[56px] h-[32px] relative bg-[#1f1f22] rounded-[16px]" />
          <div className="w-[28px] h-[28px] bg-[#aff4c6] rounded-[14px] shadow-[0_1px_3px_rgba(0,0,0,0.1),0_1px_2px_rgba(0,0,0,0.1),0_2px_4px_rgba(0,0,0,0.1)] absolute top-[2px] left-[2px]" />
          <div className="w-[24px] h-[24px] relative">
            <div className="w-[10px] h-[10px] relative -[1.5px] -[#1f1f22] rounded-none" />
            <div className="w-[0px] h-[2.5px] -[1.5px] -[#1f1f22] absolute top-[7px] left-[0px]" />
            <div className="w-[0px] h-[2.5px] -[1.5px] -[#1f1f22] absolute top-[0px] left-[7px]" />
            <div className="w-[14.14px] h-[14.14px] -[1.5px] -[#1f1f22] rotate-45 absolute top-[7px] left-[7px]" />
            <div className="w-[14.14px] h-[14.14px] -[1.5px] -[#1f1f22] -rotate-45 absolute top-[7px] left-[7px]" />
          </div>
        </div>
      </section>
    </aside>
  );
}
