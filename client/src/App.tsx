import { useState } from "react";
import { SafeAreaTopScrim } from "@hatch/space-sdk/client";
import { ShoppingTab } from "./ShoppingTab";
import { HitListTab } from "./HitListTab";
import { MealPlannerTab } from "./MealPlannerTab";
import { BitApp } from "./BitApp";
import { HouseholdSetup } from "./HouseholdSetup";
import { AccountPolicy } from "./AccountPolicy";
import {
GearButton,
SettingsDrawer,
SettingsDrawerItem,
UndoLastActionItem,
} from "./SettingsDrawer";
import { RecipeVideosSection } from "./RecipeVideosSection";

type Tab = "shopping" | "hit" | "meals";
type Side = "chooser" | "hit" | "bit";

/** The app's display title, version included. Every place the title
    shows follows from this one constant.
    The Beta number is a decimal counter: each app update adds 0.01.
    The second decimal digit increments (0.53 → 0.54 → … → 0.59), then
    resets to 0 while the first decimal digit increments (0.59 → 0.60),
    carrying into the integer at 0.99 → 1.00. (The counter ran as
    Alpha up to 0.99; update 101 renamed it Beta and restarted the
    numbering at 0.01.) */
export const APP_TITLE = "HitBit - Beta 0.15";

const TABS: { id: Tab; label: string }[] = [
  { id: "meals", label: "Meal Planner" },
  { id: "shopping", label: "Shopping List" },
  { id: "hit", label: "HIT List" },
];

/**
 * Chooser illustration for the household side: a cozy house in a
 * neighbourhood — shingled pitched roof, brick chimney with a
 * gentle curl of smoke, framed warm-lit windows with a glass
 * shine, a panelled door with step and lantern, shrubs and
 * flowers, a driveway, a tree and a picket fence, neighbour
 * houses, a soft sun. The clouds loop gently inside their own
 * patches of sky. Fills follow the --scene-* theme tokens, so
 * the scene sits correctly in dark mode too. Inline SVG + CSS
 * animation (classes in theme.css); prefers-reduced-motion
 * shows a still frame.
 */
function HouseScene() {
  return (
    <svg
      viewBox="0 0 320 120"
      className="chooser-scene mb-3 w-full"
      role="img"
      aria-label="A cozy house in a neighbourhood"
    >
      <defs>
        <clipPath id="house-roof-clip">
          <polygon points="114,64 160,38 206,64" />
        </clipPath>
      </defs>
      {/* Sky */}
      <rect x="0" y="0" width="320" height="120" rx="10" fill="var(--scene-sky)" />
      {/* Sun, with short rays */}
      <circle cx="282" cy="24" r="17" fill="#f7cf5a" opacity="0.35" />
      <circle cx="282" cy="24" r="11" fill="#f7cf5a" />
      <g stroke="#f7cf5a" strokeWidth="2" strokeLinecap="round">
        <line x1="282" y1="2" x2="282" y2="6" />
        <line x1="304" y1="24" x2="300" y2="24" />
        <line x1="297" y1="9" x2="294" y2="12" />
        <line x1="267" y1="9" x2="270" y2="12" />
        <line x1="260" y1="24" x2="264" y2="24" />
      </g>
      {/* Clouds: each loops gently inside its own patch of sky */}
      <g className="scene-cloud-a" fill="var(--scene-cloud)" opacity="0.95">
        <ellipse cx="46" cy="24" rx="17" ry="7" />
        <ellipse cx="60" cy="18" rx="12" ry="6.5" />
        <ellipse cx="70" cy="24" rx="13" ry="6" />
        <rect x="32" y="22" width="50" height="5" rx="2.5" />
      </g>
      <g className="scene-cloud-b" fill="var(--scene-cloud)" opacity="0.8">
        <ellipse cx="188" cy="15" rx="13" ry="5.5" />
        <ellipse cx="198" cy="11" rx="9" ry="5" />
        <ellipse cx="206" cy="15" rx="10" ry="4.5" />
      </g>
      {/* Distant hill band */}
      <ellipse cx="60" cy="98" rx="90" ry="14" fill="var(--scene-grass-dark)" opacity="0.45" />
      <ellipse cx="270" cy="100" rx="80" ry="12" fill="var(--scene-grass-dark)" opacity="0.35" />
      {/* Ground */}
      <rect x="0" y="92" width="320" height="28" fill="var(--scene-grass)" />
      {/* Neighbour houses */}
      <g opacity="0.8">
        <rect x="14" y="72" width="34" height="22" fill="var(--scene-wall)" />
        <polygon points="10,73 31,60 52,73" fill="#b0866a" />
        <polygon points="31,60 52,73 31,73" fill="#000000" opacity="0.12" />
        <rect x="26" y="80" width="8" height="8" fill="#ffd98a" stroke="#c9a24d" strokeWidth="1" />
        <line x1="27.5" y1="86" x2="32.5" y2="81" stroke="#ffffff" strokeWidth="1" opacity="0.6" />
        <rect x="38" y="82" width="6" height="12" fill="#8a5a3b" />
      </g>
      <g opacity="0.8">
        <rect x="272" y="74" width="32" height="20" fill="var(--scene-wall)" />
        <polygon points="268,75 288,63 308,75" fill="#7d94a6" />
        <polygon points="288,63 308,75 288,75" fill="#000000" opacity="0.12" />
        <rect x="283" y="81" width="8" height="8" fill="#ffd98a" stroke="#c9a24d" strokeWidth="1" />
        <rect x="294" y="83" width="6" height="11" fill="#6d7f8c" />
      </g>
      {/* Tree: trunk, branches, layered canopy, fruit */}
      <rect x="88" y="76" width="6" height="20" fill="#8a5a3b" />
      <path d="M91 80 L82 70 M91 78 L100 68" stroke="#8a5a3b" strokeWidth="2.5" strokeLinecap="round" />
      <circle cx="91" cy="62" r="15" fill="#5da464" />
      <circle cx="78" cy="71" r="10" fill="#6cb271" />
      <circle cx="104" cy="71" r="10" fill="#6cb271" />
      <circle cx="84" cy="56" r="4.5" fill="#ffffff" opacity="0.22" />
      <g fill="#e2574c">
        <circle cx="84" cy="66" r="1.4" />
        <circle cx="98" cy="59" r="1.4" />
        <circle cx="93" cy="73" r="1.4" />
      </g>
      {/* Chimney smoke */}
      <g fill="var(--scene-cloud)">
        <circle className="scene-smoke scene-smoke-1" cx="199" cy="34" r="4" />
        <circle className="scene-smoke scene-smoke-2" cx="201" cy="30" r="5" />
        <circle className="scene-smoke scene-smoke-3" cx="203" cy="26" r="6" />
      </g>
      {/* House: soft ground shadow first */}
      <ellipse cx="161" cy="98" rx="52" ry="4.5" fill="var(--scene-shadow)" />
      {/* Chimney with cap and brick lines */}
      <rect x="188" y="36" width="11" height="18" fill="#b0663f" />
      <rect x="186.5" y="34" width="14" height="3.5" rx="1" fill="#96522f" />
      <line x1="188" y1="42" x2="199" y2="42" stroke="#96522f" strokeWidth="1" />
      <line x1="188" y1="48" x2="199" y2="48" stroke="#96522f" strokeWidth="1" />
      {/* Walls, with a shaded right edge */}
      <rect x="122" y="62" width="76" height="34" fill="var(--scene-wall)" />
      <rect x="190" y="62" width="8" height="34" fill="#000000" opacity="0.05" />
      {/* Roof with shingle rows (clipped to the roof) */}
      <polygon points="114,64 160,38 206,64" fill="var(--scene-roof)" />
      <g clipPath="url(#house-roof-clip)" stroke="#000000" strokeWidth="1.1" opacity="0.16">
        <line x1="106" y1="47" x2="214" y2="47" />
        <line x1="106" y1="54" x2="214" y2="54" />
        <line x1="106" y1="61" x2="214" y2="61" />
        <line x1="130" y1="40" x2="122" y2="64" />
        <line x1="148" y1="40" x2="144" y2="64" />
        <line x1="172" y1="40" x2="176" y2="64" />
        <line x1="190" y1="40" x2="198" y2="64" />
      </g>
      <line x1="156" y1="39.5" x2="164" y2="39.5" stroke="#a5563a" strokeWidth="2.5" strokeLinecap="round" />
      {/* Windows: frames, mullions, glass shine, sills */}
      <g>
        <rect x="129" y="69" width="15" height="15" fill="#ffffff" stroke="#b08954" strokeWidth="1.2" />
        <rect x="131" y="71" width="11" height="11" fill="#ffcf5c" />
        <line x1="136.5" y1="71" x2="136.5" y2="82" stroke="#b08954" strokeWidth="1.1" />
        <line x1="131" y1="76.5" x2="142" y2="76.5" stroke="#b08954" strokeWidth="1.1" />
        <polygon points="132.5,81 137,71.5 139.5,71.5 135,81" fill="#ffffff" opacity="0.45" />
        <rect x="128" y="84" width="17" height="2" rx="1" fill="#b08954" />
      </g>
      <g>
        <rect x="176" y="69" width="15" height="15" fill="#ffffff" stroke="#b08954" strokeWidth="1.2" />
        <rect x="178" y="71" width="11" height="11" fill="#ffcf5c" />
        <line x1="183.5" y1="71" x2="183.5" y2="82" stroke="#b08954" strokeWidth="1.1" />
        <line x1="178" y1="76.5" x2="189" y2="76.5" stroke="#b08954" strokeWidth="1.1" />
        <polygon points="179.5,81 184,71.5 186.5,71.5 182,81" fill="#ffffff" opacity="0.45" />
        <rect x="175" y="84" width="17" height="2" rx="1" fill="#b08954" />
      </g>
      {/* Door: arched top, panels, knob, step and mat; lantern beside it */}
      <path d="M152 96 L152 81 Q152 74.5 160 74.5 Q168 74.5 168 81 L168 96 Z" fill="#9c6642" />
      <rect x="155" y="79" width="10" height="6" rx="1" fill="none" stroke="#000000" strokeWidth="0.9" opacity="0.25" />
      <rect x="155" y="87" width="10" height="6" rx="1" fill="none" stroke="#000000" strokeWidth="0.9" opacity="0.25" />
      <circle cx="165" cy="87" r="1.6" fill="#f7e3b0" />
      <rect x="149" y="96" width="22" height="3" rx="1" fill="var(--surface-alt)" />
      <rect x="152" y="100.5" width="16" height="2.5" rx="1" fill="#b08954" opacity="0.65" />
      <rect x="171.5" y="77" width="3.5" height="5.5" rx="1" fill="#5b4632" />
      <circle cx="173.2" cy="79.8" r="1.1" fill="#ffd98a" />
      {/* Path with stepping stones */}
      <polygon points="155,120 165,120 163,99 157,99" fill="var(--surface-alt)" />
      <g fill="#000000" opacity="0.07">
        <ellipse cx="160" cy="104" rx="3" ry="1.4" />
        <ellipse cx="160" cy="110" rx="3.4" ry="1.5" />
        <ellipse cx="160" cy="116" rx="3.8" ry="1.6" />
      </g>
      {/* Driveway on the right */}
      <polygon points="238,120 282,120 246,96 226,96" fill="var(--surface-alt)" opacity="0.85" />
      <line x1="252" y1="118" x2="240" y2="98" stroke="#000000" strokeWidth="1" opacity="0.08" />
      {/* Shrubs with flowers along the house front */}
      <g fill="var(--scene-grass-dark)">
        <circle cx="126" cy="93" r="5.5" />
        <circle cx="135" cy="95" r="4" />
        <circle cx="193" cy="93" r="5.5" />
        <circle cx="185" cy="95" r="4" />
      </g>
      <g>
        <circle cx="124" cy="90" r="1.3" fill="#e88ca0" />
        <circle cx="130" cy="94" r="1.2" fill="#f7cf5a" />
        <circle cx="195" cy="90" r="1.3" fill="#e88ca0" />
        <circle cx="188" cy="93" r="1.2" fill="#ffffff" />
      </g>
      {/* Picket fence, pointed tops and two rails, front-left */}
      <g fill="#ffffff" opacity="0.92">
        <rect x="6" y="92" width="48" height="2.6" />
        <rect x="6" y="97" width="48" height="2.6" />
        <polygon points="8,102 8,89 10.5,86 13,89 13,102" />
        <polygon points="18,102 18,89 20.5,86 23,89 23,102" />
        <polygon points="28,102 28,89 30.5,86 33,89 33,102" />
        <polygon points="38,102 38,89 40.5,86 43,89 43,102" />
        <polygon points="48,102 48,89 50.5,86 53,89 53,102" />
      </g>
      {/* Grass tufts */}
      <g stroke="var(--scene-grass-dark)" strokeWidth="1.4" strokeLinecap="round">
        <path d="M64 108 l-1.5 -4 M66 108 l0.5 -4.5 M68 108 l2 -3.5" fill="none" />
        <path d="M296 106 l-1.5 -4 M298 106 l0.5 -4.5 M300 106 l2 -3.5" fill="none" />
        <path d="M108 114 l-1.5 -4 M110 114 l0.5 -4.5 M112 114 l2 -3.5" fill="none" />
      </g>
    </svg>
  );
}

/**
 * Chooser illustration for the business side: a friendly box truck
 * chugging down a road — panelled cargo box with a roll-up rear
 * door, a detailed cab (window shine, mirror, grille, headlight),
 * hubcapped wheels spinning, a slight bob, a dashed road line
 * scrolling beneath it, small exhaust puffs trailing behind, and
 * hills, trees, a house and wired poles passing slowly for a
 * sense of travel. Fills follow the --scene-* theme tokens, so
 * the scene sits correctly in dark mode too. Inline SVG + CSS
 * animation (classes in theme.css); prefers-reduced-motion
 * shows a still frame.
 */
function TruckScene() {
  return (
    <svg
      viewBox="0 0 320 120"
      className="chooser-scene mb-3 w-full"
      role="img"
      aria-label="A freight truck driving down a road"
    >
      {/* Sky */}
      <rect x="0" y="0" width="320" height="120" rx="10" fill="var(--scene-sky)" />
      <circle cx="34" cy="20" r="15" fill="#f7cf5a" opacity="0.35" />
      <circle cx="34" cy="20" r="10" fill="#f7cf5a" />
      <g stroke="#f7cf5a" strokeWidth="2" strokeLinecap="round">
        <line x1="34" y1="1" x2="34" y2="5" />
        <line x1="53" y1="20" x2="49" y2="20" />
        <line x1="15" y1="20" x2="19" y2="20" />
      </g>
      <g className="scene-cloud-a" fill="var(--scene-cloud)" opacity="0.9">
        <ellipse cx="232" cy="20" rx="15" ry="6.5" />
        <ellipse cx="244" cy="14" rx="10" ry="5.5" />
        <ellipse cx="254" cy="20" rx="11" ry="5" />
      </g>
      {/* Passing scenery: shaped hills, trees, a small house and
          wired poles, duplicated for the loop */}
      <g className="scene-scenery">
        <ellipse cx="40" cy="94" rx="52" ry="15" fill="var(--scene-grass)" />
        <ellipse cx="200" cy="96" rx="64" ry="13" fill="var(--scene-grass-dark)" opacity="0.55" />
        {/* Tree */}
        <rect x="58" y="74" width="4.5" height="18" fill="#8a5a3b" />
        <circle cx="60" cy="65" r="11" fill="var(--scene-grass-dark)" />
        <circle cx="51" cy="71" r="7" fill="var(--scene-grass)" />
        <circle cx="69" cy="71" r="7" fill="var(--scene-grass)" />
        {/* Small house */}
        <rect x="168" y="72" width="26" height="20" fill="var(--scene-wall)" />
        <polygon points="165,73 181,62 197,73" fill="var(--scene-roof)" />
        <rect x="177" y="81" width="7" height="11" fill="#9c6642" />
        <rect x="186" y="77" width="6" height="6" fill="#ffd98a" stroke="#c9a24d" strokeWidth="0.8" />
        {/* Poles with a sagging wire between them */}
        <path d="M124 58 Q198 67 272 58" fill="none" stroke="var(--dim)" strokeWidth="1" opacity="0.45" />
        <g fill="#9aa3ab">
          <rect x="120" y="52" width="4" height="42" />
          <rect x="110" y="56" width="24" height="3" />
          <rect x="268" y="52" width="4" height="42" />
          <rect x="258" y="56" width="24" height="3" />
        </g>
        <ellipse cx="360" cy="94" rx="52" ry="15" fill="var(--scene-grass)" />
        <ellipse cx="520" cy="96" rx="64" ry="13" fill="var(--scene-grass-dark)" opacity="0.55" />
        <rect x="378" y="74" width="4.5" height="18" fill="#8a5a3b" />
        <circle cx="380" cy="65" r="11" fill="var(--scene-grass-dark)" />
        <circle cx="371" cy="71" r="7" fill="var(--scene-grass)" />
        <circle cx="389" cy="71" r="7" fill="var(--scene-grass)" />
        <rect x="488" y="72" width="26" height="20" fill="var(--scene-wall)" />
        <polygon points="485,73 501,62 517,73" fill="var(--scene-roof)" />
        <rect x="497" y="81" width="7" height="11" fill="#9c6642" />
        <rect x="506" y="77" width="6" height="6" fill="#ffd98a" stroke="#c9a24d" strokeWidth="0.8" />
        <path d="M444 58 Q518 67 592 58" fill="none" stroke="var(--dim)" strokeWidth="1" opacity="0.45" />
        <g fill="#9aa3ab">
          <rect x="440" y="52" width="4" height="42" />
          <rect x="430" y="56" width="24" height="3" />
          <rect x="588" y="52" width="4" height="42" />
          <rect x="578" y="56" width="24" height="3" />
        </g>
      </g>
      {/* Road with a lighter top edge */}
      <rect x="0" y="94" width="320" height="26" fill="var(--scene-road)" />
      <rect x="0" y="94" width="320" height="2" fill="#ffffff" opacity="0.22" />
      <line
        x1="0"
        y1="107"
        x2="320"
        y2="107"
        stroke="#f5f2e8"
        strokeWidth="3"
        strokeDasharray="18 16"
        className="scene-road-dash"
      />
      {/* Soft ground shadow under the truck */}
      <ellipse cx="171" cy="109" rx="96" ry="5" fill="var(--scene-shadow)" />
      {/* Exhaust puffs */}
      <g fill="var(--scene-cloud)" opacity="0.85">
        <circle className="scene-puff scene-puff-1" cx="72" cy="90" r="4" />
        <circle className="scene-puff scene-puff-2" cx="66" cy="92" r="5" />
        <circle className="scene-puff scene-puff-3" cx="58" cy="94" r="6" />
      </g>
      {/* Truck */}
      <g className="scene-truck">
        {/* Cargo box: panel lines, rear roll-up door, rivets,
            marker lights, accent stripe */}
        <rect x="86" y="38" width="118" height="48" rx="4" fill="var(--surface)" stroke="var(--border)" strokeWidth="1.5" />
        <g stroke="var(--border)" strokeWidth="1">
          <line x1="112" y1="42" x2="112" y2="82" />
          <line x1="136" y1="42" x2="136" y2="82" />
          <line x1="160" y1="42" x2="160" y2="82" />
          <line x1="184" y1="42" x2="184" y2="82" />
        </g>
        <rect x="90" y="42" width="15" height="40" fill="none" stroke="var(--border)" strokeWidth="1.2" />
        <g stroke="var(--border)" strokeWidth="1">
          <line x1="90" y1="50" x2="105" y2="50" />
          <line x1="90" y1="58" x2="105" y2="58" />
          <line x1="90" y1="66" x2="105" y2="66" />
          <line x1="90" y1="74" x2="105" y2="74" />
        </g>
        <rect x="86" y="56" width="118" height="10" fill="var(--accent)" opacity="0.85" />
        <g fill="var(--border)">
          <circle cx="120" cy="43" r="1" />
          <circle cx="144" cy="43" r="1" />
          <circle cx="168" cy="43" r="1" />
          <circle cx="192" cy="43" r="1" />
        </g>
        <g fill="#f7cf5a">
          <circle cx="94" cy="40.5" r="1.4" />
          <circle cx="145" cy="40.5" r="1.4" />
          <circle cx="196" cy="40.5" r="1.4" />
        </g>
        {/* Exhaust stack behind the cab */}
        <rect x="199.5" y="44" width="4" height="42" fill="#6b7280" />
        <rect x="198.5" y="42" width="6" height="3" rx="1" fill="#565d64" />
        {/* Cab: body, shading, window with shine, door seam and
            handle, mirror, grille, headlight, bumper, step */}
        <rect x="204" y="52" width="34" height="34" fill="var(--accent)" />
        <rect x="238" y="66" width="18" height="20" rx="3" fill="var(--accent)" />
        <rect x="204" y="52" width="34" height="6" fill="#ffffff" opacity="0.18" />
        <line x1="231" y1="54" x2="231" y2="84" stroke="#000000" strokeWidth="1.2" opacity="0.22" />
        <polygon points="210,56 232,56 238,70 210,70" fill="#d8eefb" />
        <polygon points="215,57 222,57 227,69 221,69" fill="#ffffff" opacity="0.5" />
        <rect x="222" y="73" width="6.5" height="2.2" rx="1" fill="#000000" opacity="0.35" />
        <line x1="237" y1="59" x2="243" y2="56" stroke="#33383e" strokeWidth="1.6" />
        <rect x="242" y="51" width="4.5" height="9.5" rx="1.2" fill="#33383e" />
        <rect x="246" y="70" width="9" height="10" rx="1.5" fill="#000000" opacity="0.28" />
        <g stroke="#ffffff" strokeWidth="1" opacity="0.35">
          <line x1="248.5" y1="71" x2="248.5" y2="79" />
          <line x1="251.5" y1="71" x2="251.5" y2="79" />
        </g>
        <circle cx="252" cy="81.5" r="2.4" fill="#ffe9a8" stroke="#000000" strokeWidth="0.6" opacity="0.95" />
        <rect x="235" y="84" width="23" height="4" rx="2" fill="#9aa3ab" />
        <rect x="206" y="84" width="20" height="3" fill="#4a5058" />
        {/* Chassis, fuel tank, mudflaps */}
        <rect x="86" y="86" width="170" height="5" fill="#4a5058" />
        <rect x="148" y="88" width="34" height="8" rx="4" fill="#9aa3ab" stroke="#000000" strokeWidth="0.8" opacity="0.9" />
        <rect x="101" y="91" width="5" height="11" fill="#33383e" />
        <rect x="215" y="91" width="5" height="11" fill="#33383e" />
        {/* Wheels: hubcaps with lug dots so the spin reads */}
        <g className="scene-wheel">
          <circle cx="118" cy="97" r="11" fill="#33383e" />
          <circle cx="118" cy="97" r="7" fill="#454b52" />
          <circle cx="118" cy="97" r="4.2" fill="#d7dde3" />
          <g fill="#33383e">
            <circle cx="118" cy="94.6" r="0.9" />
            <circle cx="118" cy="99.4" r="0.9" />
            <circle cx="115.6" cy="97" r="0.9" />
            <circle cx="120.4" cy="97" r="0.9" />
          </g>
        </g>
        <g className="scene-wheel">
          <circle cx="230" cy="97" r="11" fill="#33383e" />
          <circle cx="230" cy="97" r="7" fill="#454b52" />
          <circle cx="230" cy="97" r="4.2" fill="#d7dde3" />
          <g fill="#33383e">
            <circle cx="230" cy="94.6" r="0.9" />
            <circle cx="230" cy="99.4" r="0.9" />
            <circle cx="227.6" cy="97" r="0.9" />
            <circle cx="232.4" cy="97" r="0.9" />
          </g>
        </g>
      </g>
    </svg>
  );
}

/**
 * The launch chooser: shown on every fresh launch, before any tabs.
 * Two large tappable choices — HIT (the household side, unchanged)
 * and BIT (the business side, its own data). Each side's settings
 * drawer (the gear beside its title) carries the switch control
 * that goes straight to the other side — "Switch to BIT" on the
 * household side lands directly on BIT, "Switch to HIT" on the
 * business side lands directly on HIT; neither returns here.
 */
function LaunchChooser({ onPick }: { onPick: (side: Side) => void }) {
  return (
    <div className="pt-6">
      <h1 className="text-center text-2xl font-extrabold">{APP_TITLE}</h1>
      <div className="mt-4 flex flex-col gap-3">
        <button
          type="button"
          onClick={() => onPick("hit")}
          className="rounded-2xl border-2 p-4 text-left"
          style={{
            borderColor: "var(--accent)",
            backgroundColor: "var(--surface)",
          }}
        >
          <HouseScene />
          <span className="text-xl font-bold">
            HIT — Household Inventory Tracker
          </span>
        </button>
        <div className="bit-scope">
          <button
            type="button"
            onClick={() => onPick("bit")}
            className="w-full rounded-2xl border-2 p-4 text-left"
            style={{
              borderColor: "var(--accent)",
              backgroundColor: "var(--surface)",
            }}
          >
            <TruckScene />
            <span className="text-xl font-bold">
              BIT — Business Inventory Tracker
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}

export function App() {
  // A fresh launch lands on the chooser; entering a side shows that
  // side's interface, and each side's switch control jumps straight
  // to the other side (never back here). Component state only —
  // nothing is persisted, so relaunching the app always shows the
  // chooser again.
  const [side, setSide] = useState<Side>("chooser");
  const [tab, setTab] = useState<Tab>("meals");
  // Leftover receipt lines' Add button (Shopping List tab): each
  // tap bumps this signal and lands the user on the HIT List tab,
  // whose Add item form opens on the signal — the same place the
  // HIT List's own "Add item" button leads. The HIT List tab
  // resets the signal to 0 once it has opened the form.
  const [hitAddSignal, setHitAddSignal] = useState(0);
  // HIT setup questionnaire (Alpha 0.90): opened from the Setup
  // entry in the settings drawer; an in-flow page that takes
  // the place of the tab content while it's open. It never opens
  // on its own — the household is already set up.
  const [hitSetupOpen, setHitSetupOpen] = useState(false);
  // Accessibility (audit #5, second half): the Primary vs
  // Connected settings page — acting role + undo policy. Opened
  // from the settings drawer like Household Setup; an in-flow page
  // that replaces the tab content while open. The account system
  // lives here, not in the daily flows.
  const [accountOpen, setAccountOpen] = useState(false);
  // Settings drawer: opened by the gear beside the app title; it
  // holds the Accessibility entry, Household Setup, Recipe
  // Videos, and the Switch control (moved out of the side strip).
  const [settingsOpen, setSettingsOpen] = useState(false);
  // One random seed per app launch (page load). It lives here, above
  // the tabs, so switching tabs doesn't reshuffle — only relaunching
  // the app does. The Meal Planner uses it to shuffle its meal
  // suggestions.
  const [suggestionSeed] = useState(
    () => Math.floor(Math.random() * 2_147_483_647) + 1,
  );

  return (
    <div className="min-h-screen bg-[var(--bg)]">
      <SafeAreaTopScrim backgroundColor="var(--bg)" />
      <main className="mx-auto w-full max-w-2xl px-4 pb-4">
        {side === "chooser" && (
          <LaunchChooser onPick={(s) => setSide(s)} />
        )}

        {side === "bit" && <BitApp onSwitch={() => setSide("hit")} />}

        {side === "hit" && (
          <>
            {/* Side strip: the app title, enlarged to fill its
                row, with the settings gear beside it. The title
                flexes and truncates first — the gear is shrink-0
                and is never crowded out. The gear opens the
                settings drawer from the left, which now holds the
                Accessibility entry, Household Setup, Recipe
                Videos, and the switch control that goes straight
                to the BIT side (all moved out of this strip). */}
            <div className="flex items-center gap-2 pt-2">
              <span
                className="min-w-0 flex-1 truncate text-2xl font-extrabold sm:text-3xl"
                style={{ color: "var(--accent)" }}
              >
                {APP_TITLE}
              </span>
              <GearButton
                open={settingsOpen}
                onClick={() => setSettingsOpen(true)}
              />
            </div>

            <SettingsDrawer
              open={settingsOpen}
              onClose={() => setSettingsOpen(false)}
            >
              <SettingsDrawerItem
                label="Accessibility"
                onClick={() => {
                  setSettingsOpen(false);
                  setAccountOpen(true);
                  setHitSetupOpen(false);
                }}
              />
              <SettingsDrawerItem
                label="Household Setup"
                onClick={() => {
                  setSettingsOpen(false);
                  setHitSetupOpen(true);
                  setAccountOpen(false);
                }}
              />
              <SettingsDrawerItem
                label="⇄ Switch to BIT"
                onClick={() => {
                  setSettingsOpen(false);
                  setHitSetupOpen(false);
                  setAccountOpen(false);
                  setSide("bit");
                }}
              />
              {/* The app's one Undo (Beta 0.15), under Switch to:
                  reverts the last action taken anywhere in the
                  app. There are no per-record Undo buttons. */}
              <UndoLastActionItem />
              {/* Recipe Videos lives in the drawer now (moved out
                  of the bottom of the Meal Planner tab): its
                  collapsible section renders here in full. */}
              <RecipeVideosSection />
            </SettingsDrawer>

            {accountOpen ? (
              <AccountPolicy onClose={() => setAccountOpen(false)} />
            ) : hitSetupOpen ? (
              <HouseholdSetup onClose={() => setHitSetupOpen(false)} />
            ) : (
              <>
            {/* Tab bar */}
            <nav aria-label="Household lists" className="pt-2">
              <div
                className="flex rounded-full p-1"
                style={{ backgroundColor: "var(--surface)" }}
                role="group"
              >
                {TABS.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    aria-pressed={tab === t.id}
                    onClick={() => setTab(t.id)}
                    className="min-w-0 flex-1 truncate rounded-full px-2 py-2 text-sm font-bold"
                    style={
                      tab === t.id
                        ? {
                            backgroundColor: "var(--accent)",
                            color: "var(--accent-text)",
                          }
                        : { color: "var(--dim)" }
                    }
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </nav>

            {tab === "shopping" && (
              <ShoppingTab
                onAddReceiptItem={() => {
                  setHitAddSignal((n) => n + 1);
                  setTab("hit");
                }}
              />
            )}
            {tab === "hit" && (
              <HitListTab
                addItemSignal={hitAddSignal}
                onAddItemSignalHandled={() => setHitAddSignal(0)}
              />
            )}
            {tab === "meals" && (
              <MealPlannerTab suggestionSeed={suggestionSeed} />
            )}
              </>
            )}
          </>
        )}
      </main>
    </div>
  );
}
