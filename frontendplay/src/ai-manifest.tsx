// ÄGS AV BOTTEN – ändra inte för hand.
import React from "react";
import Menud96dc2 from './components/ai/Menu-d96dc2';
import "./index.css";

// OBS: markörer används av botten för att veta var append ska ske.
// Använd EXAKT samma markörnamen som ditt system redan letar efter.
// Om du inte vet namnen: kopiera de marker-kommentarer som idag finns i main.tsx.
export default function AIMount() {
  return (
    <>
       {/* AI-INJECT-MOUNT:BEGIN */}
       <div id="__AI_MOUNT_GRID__" className="flex flex-wrap gap-4 items-start">
       
       <> {/* AI-TILE:./components/ai/Menu-d96dc2:BEGIN */}
       <div className="relative w-[1280px] h-[800px] overflow-hidden rounded-md ring-1 ring-black/10 bg-white">
       <Menud96dc2 />
       </div> {/* AI-TILE:./components/ai/Menu-d96dc2:END */}</></div>
       {/* AI-INJECT-MOUNT:END */}
    </>
  );
}
