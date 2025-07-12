import { FunctionComponent } from 'react';
const Menu:FunctionComponent = () => {
return (
<div className="relative bg-gray-200 border-gray-100 border-solid border-r-[1px] box-border w-full h-[1024px] overflow-hidden flex flex-col items-start justify-between pt-6 px-6 pb-8 gap-0 text-left text-base text-whitesmoke font-open-sans">
<div className="self-stretch flex flex-col items-start justify-start gap-11">
<div className="flex flex-row items-center justify-start gap-3">
<div className="w-14 relative rounded-2xl bg-mediumseagreen h-14" />
<div className="flex flex-col items-start justify-center">
<b className="w-[150px] relative inline-block">Duck UI</b>
<div className="w-[150px] relative text-sm text-silver inline-block">Duckui@demo.com</div>
</div>
</div>
<div className="w-[218px] rounded-2xl bg-gray-100 flex flex-col items-start justify-center p-4 box-border">
<div className="w-[186px] h-6 flex flex-row items-center justify-start gap-4">
<div className="w-6 relative h-6">
<div className="absolute top-[3.25px] left-[3.25px] rounded-[50%] border-aquamarine border-solid border-[1.5px] box-border w-[15.5px] h-[15.5px]" />
<img className="absolute top-[16px] left-[16px] w-[3.5px] h-[3.5px] object-contain" alt="" src="Vector 1280.svg" />
</div>
<div className="w-[146px] relative leading-[140%] inline-block shrink-0">Search...</div>
</div>
</div>
<div className="flex flex-col items-start justify-start gap-6">
<div className="rounded-lg flex flex-col items-start justify-start p-4">
<div className="w-[186px] h-6 flex flex-row items-center justify-start gap-4">
<div className="w-6 relative h-6">
<img className="absolute h-[79.17%] w-9/12 top-[8.33%] right-[12.5%] bottom-[12.5%] left-[12.5%] max-w-full overflow-hidden max-h-full" alt="" src="Rectangle 2804.svg" />
</div>
<div className="relative leading-[140%]">Dashboard</div>
</div>
</div>
<div className="rounded-lg flex flex-col items-start justify-start p-4">
<div className="w-[186px] h-6 flex flex-row items-center justify-start gap-4">
<div className="w-6 relative h-6 overflow-hidden shrink-0">
<img className="absolute h-[83.33%] w-9/12 top-[8.33%] right-[12.5%] bottom-[8.33%] left-[12.5%] max-w-full overflow-hidden max-h-full" alt="" src="Icon.svg" />
</div>
<div className="relative leading-[140%]">Ad Optimizer</div>
</div>
</div>
<div className="rounded-lg flex flex-col items-start justify-start p-4">
<div className="w-[186px] h-6 flex flex-row items-center justify-start gap-4">
<img className="w-6 relative h-6" alt="" src="chat_bubble.svg" />
<div className="relative leading-[140%]">AI Assistant</div>
</div>
</div>
<div className="rounded-lg flex flex-col items-start justify-start p-4">
<div className="w-[186px] h-6 flex flex-row items-center justify-start gap-4">
<div className="w-6 relative h-6">
<img className="absolute top-[2px] left-[2px] w-5 h-5" alt="" src="Cicle.svg" />
<img className="absolute top-[2px] left-[14px] rounded-[0.5px] w-2 h-2" alt="" src="Cicle.svg" />
</div>
<div className="relative leading-[140%]">Analytics</div>
</div>
</div>
</div>
</div>
<div className="self-stretch flex flex-col items-start justify-start">
<div className="rounded-lg flex flex-col items-start justify-start p-4">
<div className="w-[186px] h-6 flex flex-row items-center justify-start gap-4">
<img className="w-6 relative h-6" alt="" src="settings.svg" />
<div className="relative leading-[140%]">Settings</div>
</div>
</div>
</div>
</div>);
};
export default Menu;