import React from 'react';
import profileUrl from '../../assets/icons/profile-c08e96.svg?url';
import seachUrl from '../../assets/icons/seach-2e285b.svg?url';
import listManu1Url from '../../assets/icons/list-manu-15bd8e.svg?url';
import listManu2Url from '../../assets/icons/list-manu-a7f8da.svg?url';
import listManu3Url from '../../assets/icons/list-manu-93ef9f.svg?url';
import listManu4Url from '../../assets/icons/list-manu-cf544b.svg?url';
import listManu5Url from '../../assets/icons/list-manu-c62d81.svg?url';
import listManu6Url from '../../assets/icons/list-manu-aec45f.svg?url';
import switchToggleUrl from '../../assets/icons/switch-toggle-434ead.svg?url';

export function Menu() {
  return (
    <aside className="flex flex-col gap-[32px] pt-[24px] pr-[24px] pb-[32px] pl-[24px] items-start justify-between w-[104px] h-[1024px] relative bg-[#000000] overflow-hidden">
      <section className="flex flex-col gap-[44px] items-start justify-start w-[56px] h-[576px] relative">
        <div className="flex flex-col gap-[24px] items-start justify-start w-[56px] h-[376px] relative">
          <button type="button" className="flex flex-col gap-[10px] pt-[16px] pr-[16px] pb-[16px] pl-[16px] items-center justify-center w-[56px] h-[56px] relative rounded-[8px]">
            <img src={listManu1Url} alt="" aria-hidden="true" width={56} height={56} className="inline-block align-middle" />
          </button>
          <button type="button" className="flex flex-col gap-[10px] pt-[16px] pr-[16px] pb-[16px] pl-[16px] items-center justify-center w-[56px] h-[56px] relative rounded-[8px]">
            <img src={listManu2Url} alt="" aria-hidden="true" width={56} height={56} className="inline-block align-middle" />
          </button>
          <button type="button" className="flex flex-col gap-[10px] pt-[16px] pr-[16px] pb-[16px] pl-[16px] items-center justify-center w-[56px] h-[56px] relative rounded-[8px]">
            <img src={listManu3Url} alt="" aria-hidden="true" width={56} height={56} className="inline-block align-middle" />
          </button>
          <button type="button" className="flex flex-col gap-[10px] pt-[16px] pr-[16px] pb-[16px] pl-[16px] items-center justify-center w-[56px] h-[56px] relative rounded-[8px]">
            <img src={listManu4Url} alt="" aria-hidden="true" width={56} height={56} className="inline-block align-middle" />
          </button>
          <button type="button" className="flex flex-col gap-[10px] pt-[16px] pr-[16px] pb-[16px] pl-[16px] items-center justify-center w-[56px] h-[56px] relative rounded-[8px]">
            <img src={listManu5Url} alt="" aria-hidden="true" width={56} height={56} className="inline-block align-middle" />
          </button>
        </div>
        <div className="flex flex-col gap-[44px] items-start justify-start w-[56px] h-[576px] relative">
          <div className="flex flex-row gap-[12px] items-center justify-start w-[56px] h-[56px] relative">
            <img src={profileUrl} alt="" aria-hidden="true" width={56} height={56} className="inline-block align-middle" />
            <div className="flex flex-col items-start justify-center w-[150px] h-[41px] relative">
              <p className="text-left text-[16px] font-700 text-[#09090a] w-[150px] h-[22px]">Duck UI</p>
              <p className="text-left text-[14px] font-400 text-[#1f1f22] w-[150px] h-[19px]">Duckui@demo.com</p>
            </div>
          </div>
          <button type="button" className="flex flex-col gap-[10px] pt-[16px] pr-[16px] pb-[16px] pl-[16px] items-start justify-center w-[56px] h-[56px] relative bg-[#1f1f22] rounded-[16px]">
            <img src={seachUrl} alt="" aria-hidden="true" width={56} height={56} className="inline-block align-middle" />
          </button>
        </div>
      </section>
      <section className="flex flex-col gap-[8px] items-start justify-start w-[56px] h-[96px] relative">
        <button type="button" className="flex flex-col gap-[10px] pt-[16px] pr-[16px] pb-[16px] pl-[16px] items-center justify-center w-[56px] h-[56px] relative rounded-[8px]">
          <img src={listManu6Url} alt="" aria-hidden="true" width={56} height={56} className="inline-block align-middle" />
        </button>
        <img src={switchToggleUrl} alt="" aria-hidden="true" width={56} height={32} className="inline-block align-middle w-[56px] h-[32px] relative" />
      </section>
    </aside>
  );
}
