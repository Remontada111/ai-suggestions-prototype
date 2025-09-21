import React from 'react';

export function Menu() {
  return (
    <aside className="flex flex-col gap-8 w-[251px] h-[736px] p-6 bg-black border border-black overflow-hidden">
      {/* Top Section */}
      <section className="flex flex-col gap-11 w-[203px] h-[496px]">
        {/* Profile */}
        <div className="flex flex-row items-center gap-3 w-[218px] h-[56px]">
          <div className="w-[56px] h-[56px] bg-[#14ae5c] rounded-[16px]" />
          <div className="flex flex-col items-start justify-center w-[150px] h-[41px]">
            <p className="text-[16px] font-bold text-[#efefef]">Duck UI</p>
            <p className="text-[14px] font-normal text-[#c0bfbd]">Duckui@demo.com</p>
          </div>
        </div>

        {/* Search */}
        <div className="flex flex-col gap-[10px] p-4 w-[218px] h-[56px] bg-[#1f1f22] rounded-[16px]">
          <div className="flex flex-row items-center gap-4 w-[186px] h-[24px]">
            <div className="w-[24px] h-[24px] relative">
              <div className="w-[14px] h-[14px] border border-[#aff4c6] border-[1.5px]" />
              <div className="w-[3.5px] h-[3.5px] border border-[#aff4c6] border-[1.5px] absolute top-[10.25px] left-[14.5px]" />
            </div>
            <p className="text-[16px] font-normal text-[#efefef]">Search...</p>
          </div>
        </div>

        {/* List Items */}
        <div className="flex flex-col gap-6 w-[218px] h-[296px]">
          {/* List Manu 1 */}
          <div className="flex flex-col gap-[10px] p-4 w-[218px] h-[56px] rounded-[8px]">
            <div className="flex flex-row items-center gap-4 w-[186px] h-[24px]">
              <div className="w-[24px] h-[24px] border border-[#aff4c6] border-[1.5px]" />
              <p className="text-[16px] font-normal text-[#efefef]">Dashboard</p>
            </div>
          </div>

          {/* List Manu 2 */}
          <div className="flex flex-col gap-[10px] p-4 w-[218px] h-[56px] rounded-[8px]">
            <div className="flex flex-row items-center gap-4 w-[186px] h-[24px]">
              <div className="w-[24px] h-[24px] overflow-hidden relative border border-[#aff4c6] border-[1.5px]" />
              <p className="text-[16px] font-normal text-[#efefef]">Ad Optimizer</p>
            </div>
          </div>

          {/* List Manu 3 */}
          <div className="flex flex-col gap-[10px] p-4 w-[218px] h-[56px] rounded-[8px]">
            <div className="flex flex-row items-center gap-4 w-[186px] h-[24px]">
              <div className="w-[24px] h-[24px] relative border border-[#aff4c6] border-[1.5px] rounded-[0.5px]" />
              <p className="text-[16px] font-normal text-[#efefef]">Analytics</p>
            </div>
          </div>

          {/* List Manu 4 */}
          <div className="flex flex-col gap-[10px] p-4 w-[218px] h-[56px] rounded-[8px]">
            <div className="flex flex-row items-center gap-4 w-[186px] h-[24px]">
              <div className="w-[24px] h-[24px] relative border border-[#c8bcf6] border-[1.5px] rounded-[2px]">
                <div className="w-[6.5px] h-[0px] border border-[#c8bcf6] border-[1.5px] rounded-[0.5px] absolute top-[3px] left-[6px]" />
              </div>
              <p className="text-[16px] font-normal text-[#efefef]">Inventory</p>
            </div>
          </div>

          {/* List Manu 5 */}
          <div className="flex flex-col gap-[10px] p-4 w-[218px] h-[56px] rounded-[8px]">
            <div className="flex flex-row items-center gap-4 w-[186px] h-[24px]">
              <div className="w-[24px] h-[24px] relative border border-[#aff4c6] border-[1.5px] rounded-[0.5px]">
                <div className="w-[20px] h-[20px] bg-[#aff4c6]" />
              </div>
              <p className="text-[16px] font-normal text-[#efefef]">AI Assistant</p>
            </div>
          </div>
        </div>
      </section>

      {/* Bottom Section */}
      <section className="flex flex-col gap-2 w-[203px] h-[56px]">
        <div className="flex flex-col gap-[10px] p-4 w-[218px] h-[56px] rounded-[8px]">
          <div className="flex flex-row items-center gap-4 w-[186px] h-[24px]">
            <div className="w-[24px] h-[24px] relative overflow-hidden bg-[#aff4c6]" />
            <p className="text-[16px] font-normal text-[#efefef]">Settings</p>
          </div>
        </div>

        {/* Light/Dark Control */}
        <div className="flex flex-row items-center justify-between gap-2 p-4 w-[218px] h-[56px] rounded-[8px]">
          <div className="flex flex-row items-center gap-4 w-[124px] h-[24px]">
            <div className="w-[24px] h-[24px] relative border border-[#aff4c6] border-[1.5px] rounded-full">
              <div className="w-[10px] h-[10px] border border-[#aff4c6] rounded-full absolute top-[7px] left-[7px]" />
              <div className="w-[14px] h-[14px] border border-[#aff4c6] rounded-full absolute top-[5px] left-[5px]" />
            </div>
            <p className="text-[16px] font-normal text-[#c0bfbd]">Light mode</p>
          </div>
          <div className="w-[56px] h-[32px] relative bg-[#1f1f22] rounded-[16px]">
            <div className="w-[28px] h-[28px] bg-[#aff4c6] rounded-full shadow-[0_1px_3px_0_rgba(0,0,0,0.1),0_1px_2px_0_rgba(0,0,0,0.1),0_2px_4px_0_rgba(0,0,0,0.1)] absolute top-[2px] left-[2px]" />
          </div>
        </div>
      </section>
    </aside>
  );
}
