// Ready-made inspection templates, grouped by industry.
// When a client is created you pick their industries and these templates are copied into their account.
// Clients can edit their copies freely, and import more later from Console > Templates > Library.
// Check line format: "Name :: what must be visibly true"; a leading "!" marks a critical check.

const f = (key, label, type = 'text', extra = {}) => ({ key, label, type, ...extra });

const SCAFFOLD_AI = `SCAFFOLDING INSPECTION - terms and rules:
- Standards = vertical tubes/uprights. Ledgers = horizontal tubes along the length. Transoms = short horizontal tubes across
  the width under the boards. Base plate = flat steel plate under each standard. Sole board = timber plank under base plates.
  Ties = tubes/anchors fixing the scaffold to the building. Bracing = diagonal tubes. Couplers = clamps joining tubes.
  Guardrail = top rail about 950 mm - 1 m above the platform. Mid rail = intermediate rail. Toe board = upright plank (about 150 mm) along the platform edge.
- Judge only the part of the scaffold you can see, and say in the evidence which part you looked at.
- Bricks, blocks, loose packing, soft or uneven soil under base plates = FALSE for the sole board / firm ground check.
- Any visible gap, missing, broken or overhanging-unsupported board = FALSE for the platform check.
- An open side of a working platform without guardrail / mid rail / toe board = FALSE for that check.
- Bent, cracked, crushed or heavily corroded tubes = FALSE for the tube condition check.
- A tube end without coupler, or a coupler hanging loose = FALSE for the couplers check.
- People working without safety gear are NOT part of the checklist; mention them only under defects.`;

export const INDUSTRIES = [
  {
    key: 'construction', name: 'Construction & infrastructure',
    templates: [
      {
        key: 'scaffold', name: 'Scaffold', description: 'Access scaffold: base, structure, working platform, ladder and tag',
        idLabel: 'Scaffold ID / tag no.', safety: true, frequencyDays: 7, aiContext: SCAFFOLD_AI,
        customFields: [f('height', 'Height (m)', 'number'), f('lifts', 'Number of lifts', 'number'), f('duty', 'Duty', 'select', { options: ['Light duty', 'General duty', 'Heavy duty'] }), f('erector', 'Erected by')],
        angles: [
          { name: 'Base & foundation', guidance: 'Low angle along the bottom: all uprights, base plates and the ground', parts: ['! Base plates :: a steel base plate under every visible standard (upright)', '! Sole boards / firm ground :: base plates rest on timber sole boards on firm, level ground - no bricks, blocks or loose packing', 'Standards plumb :: uprights look vertical, not leaning, bent or sinking'] },
          { name: 'Full elevation', guidance: 'Step back and capture the whole face from bottom to top', parts: ['! Ledgers and transoms :: horizontal tubes present at every lift, none missing', '! Bracing :: diagonal (face) bracing fitted along the scaffold face', '! Ties to structure :: scaffold is tied to the building / structure at regular intervals'] },
          { name: 'Working platform', guidance: 'At platform level: deck, edges and rails in view', parts: ['! Platform fully boarded :: boards or decks cover the full width, no gaps, broken or loose boards', '! Guardrail :: top guardrail on every open side of the working platform', '! Mid rail :: intermediate rail between guardrail and toe board on open sides', '! Toe boards :: toe boards fitted along the open edges of the platform', 'Platform clear :: no heavy stacks of material, debris or trip hazards on the platform'] },
          { name: 'Access ladder', guidance: 'The ladder and the landing where it reaches the platform', parts: ['! Access ladder :: ladder is tied / secured and extends about 1 m above the landing'] },
          { name: 'Scaffold tag', guidance: 'Close-up of the tag or status board at the access point', parts: ['Scaffold tag :: an inspection tag or status board is displayed at the access point'] },
        ],
        general_parts: ['! Couplers / clamps :: fitted at the joints, none missing or hanging loose', 'Tube condition :: no bent, cracked, crushed or heavily rusted tubes'],
      },
      {
        key: 'ladder', name: 'Portable ladder', description: 'Pre-use check of a step ladder or extension ladder',
        idLabel: 'Ladder ID', safety: true, frequencyDays: 30,
        angles: [
          { name: 'Full ladder', guidance: 'Whole ladder standing or laid flat, both stiles visible', parts: ['! Stiles :: both side rails straight, not bent, cracked or split', '! Rungs / steps :: all rungs present, none bent, loose or missing'] },
          { name: 'Feet', guidance: 'Close-up of the feet at the bottom', parts: ['! Anti-slip feet :: rubber feet present on both stiles, not worn through'] },
          { name: 'Locks and label', guidance: 'Spreader / locking bars and the rating label', parts: ['Locking device :: spreader bar or rung lock present and not damaged', 'Rating label :: load rating label present and readable'] },
        ],
        general_parts: ['Clean :: no oil, grease or paint on rungs'],
      },
      {
        key: 'crane-preuse', name: 'Mobile crane pre-use', description: 'Daily visual check of a mobile / truck-mounted crane',
        idLabel: 'Crane reg. no.', safety: true, frequencyDays: 1,
        angles: [
          { name: 'Hook block', guidance: 'Close-up of hook, latch and block', parts: ['! Safety latch :: hook safety latch present and closing the hook opening', '! Hook :: no visible cracks, bending or opening of the throat'] },
          { name: 'Wire rope', guidance: 'Visible length of the hoist rope on the drum and boom', parts: ['! Wire rope :: no visible broken wires, kinks, birdcaging or crushing'] },
          { name: 'Outriggers', guidance: 'Each outrigger and its pad on the ground', parts: ['! Outriggers :: fully extended and resting on pads or mats', 'Ground :: pads on firm level ground, not on soft soil or covers'] },
          { name: 'Cab and load chart', guidance: 'Inside the cab: indicators and load chart', parts: ['Load chart :: load chart displayed in the cab', 'Load indicator :: safe-load indicator display switched on'] },
        ],
        general_parts: ['No leaks :: no hydraulic oil leaks under the crane'],
      },
    ],
  },
  {
    key: 'fire_safety', name: 'Fire & life safety',
    templates: [
      {
        key: 'fire-extinguisher', name: 'Fire extinguisher', description: 'Monthly visual check of a portable fire extinguisher',
        idLabel: 'Extinguisher ID', safety: true, frequencyDays: 30,
        customFields: [f('type', 'Extinguisher type', 'select', { options: ['ABC powder', 'CO2', 'Water', 'Foam', 'Clean agent'] }), f('expiry', 'Refill due date', 'date')],
        angles: [
          { name: 'Front and label', guidance: 'Whole extinguisher from the front, label readable', parts: ['Instruction label :: label is present and readable', 'Body condition :: no dents, rust, leaks or damage on the cylinder'] },
          { name: 'Gauge and pin', guidance: 'Close-up of the top: pressure gauge, handle, pin and seal', parts: ['! Pressure gauge :: the needle is in the green zone', '! Safety pin and seal :: pin is in place and the tamper seal is unbroken'] },
          { name: 'Hose and nozzle', guidance: 'Close-up of the hose and nozzle', parts: ['Hose and nozzle :: attached, not cracked, cut or blocked'] },
          { name: 'Mounting and tag', guidance: 'The bracket or stand and the service tag', parts: ['! Mounting :: hung on a wall bracket or placed on a stand, not lying on the floor', 'Service tag :: a service / inspection tag is attached', 'Access :: nothing blocking access to the extinguisher'] },
        ],
        general_parts: [],
      },
      {
        key: 'hose-reel', name: 'Fire hose reel', description: 'Monthly check of a fire hose reel cabinet',
        idLabel: 'Hose reel ID', safety: true, frequencyDays: 30,
        angles: [
          { name: 'Cabinet closed', guidance: 'Cabinet front with signage', parts: ['Signage :: "Fire hose reel" sign displayed', 'Access :: cabinet not blocked by material'] },
          { name: 'Cabinet open', guidance: 'Door open, reel and valve visible', parts: ['! Hose :: hose neatly wound on the reel, no cracks or cuts visible', '! Nozzle :: nozzle attached to the hose end', 'Isolation valve :: valve present with handle, no leaks'] },
        ],
        general_parts: [],
      },
      {
        key: 'emergency-exit', name: 'Emergency exit route', description: 'Weekly check of an emergency exit and escape route',
        idLabel: 'Exit no.', safety: true, frequencyDays: 7,
        angles: [
          { name: 'Exit door', guidance: 'The exit door from inside, with sign above', parts: ['! Exit sign :: illuminated exit sign above the door is lit', '! Door clear :: nothing blocking the door', 'Push bar :: panic bar / push bar fitted'] },
          { name: 'Escape route', guidance: 'Corridor or stairs leading to the exit', parts: ['! Route clear :: corridor / stairs free of stored material and obstructions', 'Emergency light :: emergency light fitting present'] },
        ],
        general_parts: [],
      },
    ],
  },
  {
    key: 'electrical', name: 'Electrical & utilities',
    templates: [
      {
        key: 'control-panel', name: 'Electrical control panel', description: 'Wall-mounted LT control panel, door closed and open',
        idLabel: 'Panel ID', safety: true, frequencyDays: 30,
        angles: [
          { name: 'Front (door closed)', guidance: 'Whole front face in frame, door closed', parts: ['Door lock :: door closes and has a handle or lock', 'Indicator lamps :: indicator lamps fitted, none missing or broken', '! Danger sticker :: danger / shock warning sticker displayed'] },
          { name: 'Inside (door open)', guidance: 'Open the door, capture all components', parts: ['MCBs / breakers :: breakers fitted, no empty or broken slots', '! Earthing wire :: earthing wire connected and tightened at the earth terminal', '! Wiring :: no loose, burnt or bare wires visible', 'Wire labels :: wires have ferrules or labels'] },
        ],
        general_parts: ['Nameplate :: nameplate or serial label present', 'Rubber mat :: insulating rubber mat on the floor in front of the panel'],
      },
      {
        key: 'dg-set', name: 'Diesel generator (DG set)', description: 'Weekly visual check of a diesel generator set',
        idLabel: 'DG set no.', safety: true, frequencyDays: 7,
        customFields: [f('hours', 'Running hours', 'number'), f('kva', 'Rating (kVA)', 'number')],
        angles: [
          { name: 'Control panel', guidance: 'Generator control panel with display', parts: ['Display :: controller display switched on with no alarm shown', '! Emergency stop :: emergency stop button present and not damaged'] },
          { name: 'Engine side', guidance: 'Canopy door open, engine side visible', parts: ['! No leaks :: no oil, fuel or coolant leaks on the engine or base', 'Belts :: fan belt present, not cracked or loose'] },
          { name: 'Fuel and battery', guidance: 'Fuel level gauge and the battery', parts: ['Fuel level :: fuel gauge shows above one quarter', 'Battery terminals :: terminals connected, no white / green corrosion'] },
        ],
        general_parts: ['Housekeeping :: area around the DG clean, no stored combustible material', '! Earthing :: earthing strips connected to the body'],
      },
    ],
  },
  {
    key: 'manufacturing', name: 'Manufacturing & engineering',
    templates: [
      {
        key: 'spare-part-kit', name: 'Spare-part kit completeness', description: 'Check that every required part is present in a kit / box before dispatch',
        idLabel: 'Kit / batch no.', safety: false, frequencyDays: null,
        aiContext: 'Count carefully. A part is present only if you can see it in the kit. If quantity is written (e.g. "4 x bolts"), the count must match. Use the reference photo (if given) as the correct kit.',
        angles: [
          { name: 'Kit open - top view', guidance: 'Box open, shot from directly above, all parts in frame', parts: ['Main part :: the main component is present', 'Fasteners :: bolts / screws packet present', 'Seals / gaskets :: seal or gasket set present'] },
          { name: 'Label and manual', guidance: 'Kit label and printed manual / instructions', parts: ['Kit label :: part number label present and readable', 'Manual :: instruction sheet or manual included'] },
        ],
        general_parts: ['No damage :: no visibly damaged, bent or broken parts'],
      },
      {
        key: 'machine-guarding', name: 'Machine guarding', description: 'Check guards and emergency stops on production machinery',
        idLabel: 'Machine no.', safety: true, frequencyDays: 7,
        angles: [
          { name: 'Operator side', guidance: 'The machine from where the operator stands', parts: ['! Fixed guards :: guards in place over moving parts, none removed or open', '! Emergency stop :: red emergency stop button present and not damaged'] },
          { name: 'Drive / belts', guidance: 'Motor, belts, chains or gears area', parts: ['! Drive guard :: belts, pulleys and chains fully covered by guards'] },
          { name: 'Signage', guidance: 'Warning signs and SOP display', parts: ['Warning signs :: safety / PPE signs displayed on or near the machine', 'SOP :: operating instructions displayed'] },
        ],
        general_parts: ['Housekeeping :: no oil spills, scrap or tools lying around the machine'],
      },
      {
        key: 'packaging-qc', name: 'Finished goods packaging QC', description: 'Outgoing packaging and labelling check before dispatch',
        idLabel: 'Batch / lot no.', safety: false, frequencyDays: null,
        angles: [
          { name: 'Carton outside', guidance: 'Whole carton with label side facing the camera', parts: ['Carton condition :: no crushed corners, tears or wet patches', 'Shipping label :: label present, barcode and address readable', 'Sealing :: carton taped / sealed on top'] },
          { name: 'Product label', guidance: 'Close-up of the product label', parts: ['Batch and date :: batch number and manufacturing date printed and readable', 'MRP :: MRP / price printed'] },
        ],
        general_parts: [],
      },
    ],
  },
  {
    key: 'automotive', name: 'Automotive & fleet',
    templates: [
      {
        key: 'vehicle-pdi', name: 'Vehicle pre-delivery inspection', description: 'Exterior and interior check before handing a vehicle to the customer',
        idLabel: 'VIN / chassis no.', safety: false, frequencyDays: null,
        customFields: [f('model', 'Model'), f('odometer', 'Odometer (km)', 'number')],
        angles: [
          { name: 'Front', guidance: 'Full front of the vehicle', parts: ['Bumper :: no scratches, dents or cracks', 'Headlamps :: both headlamps fitted, lenses not cracked', 'Number plate :: front number plate fitted'] },
          { name: 'Left side', guidance: 'Full left side', parts: ['Body panels :: no dents or scratches on doors and panels', 'Mirror :: left mirror fitted and not broken', 'Wheels :: wheel caps / alloys not scratched'] },
          { name: 'Right side', guidance: 'Full right side', parts: ['Body panels :: no dents or scratches on doors and panels', 'Mirror :: right mirror fitted and not broken'] },
          { name: 'Rear', guidance: 'Full rear of the vehicle', parts: ['Tail lamps :: both tail lamps fitted, not cracked', 'Number plate :: rear number plate fitted'] },
          { name: 'Dashboard', guidance: 'Dashboard with ignition on', parts: ['! Warning lights :: no warning lights (engine, airbag, ABS) lit on the cluster', 'Odometer :: odometer reading visible'] },
          { name: 'Boot / accessories', guidance: 'Boot open', parts: ['Spare wheel :: spare wheel present', 'Tool kit :: jack and tool kit present'] },
        ],
        general_parts: [],
      },
      {
        key: 'truck-pretrip', name: 'Truck pre-trip check', description: 'Driver daily walk-around before a trip',
        idLabel: 'Vehicle reg. no.', safety: true, frequencyDays: 1,
        angles: [
          { name: 'Front and lights', guidance: 'Front of the truck with lights on', parts: ['! Headlamps :: both headlamps lit', 'Windscreen :: no cracks in the driver view area'] },
          { name: 'Tyres', guidance: 'Close-up of the tyres on one side', parts: ['! Tyres :: no flat, bulging or badly worn tyres, tread visible', 'Wheel nuts :: all wheel nuts present'] },
          { name: 'Load area', guidance: 'Load body / trailer with the load', parts: ['! Load secured :: load tied / strapped, nothing loose or overhanging'] },
        ],
        general_parts: ['No leaks :: no oil or fuel leaks under the vehicle', 'Reflectors :: reflective tape / reflectors fitted at the rear'],
      },
    ],
  },
  {
    key: 'warehouse', name: 'Warehousing & logistics',
    templates: [
      {
        key: 'forklift', name: 'Forklift pre-use', description: 'Daily operator check of a counterbalance forklift',
        idLabel: 'Forklift no.', safety: true, frequencyDays: 1,
        angles: [
          { name: 'Forks and mast', guidance: 'Front: forks, carriage and mast', parts: ['! Forks :: both forks straight, no cracks, heel not worn thin', '! Mast chains :: lift chains present, no broken links visible', 'Backrest :: load backrest fitted'] },
          { name: 'Operator area', guidance: 'Seat, seat belt and overhead guard', parts: ['! Seat belt :: seat belt fitted and not cut', '! Overhead guard :: overhead guard fitted and not bent', 'Horn and lights :: horn button and lights present'] },
          { name: 'Tyres and body', guidance: 'Side view with tyres', parts: ['Tyres :: no chunks missing or flat tyres', 'No leaks :: no hydraulic oil leak under the truck'] },
        ],
        general_parts: ['Capacity plate :: rated capacity plate readable'],
      },
      {
        key: 'pallet-racking', name: 'Pallet racking', description: 'Visual inspection of a pallet racking bay',
        idLabel: 'Rack / bay no.', safety: true, frequencyDays: 7,
        angles: [
          { name: 'Uprights', guidance: 'Lower part of the uprights from aisle side', parts: ['! Uprights :: no dents, bends or twisted uprights', 'Column guards :: impact guards fitted at aisle ends'] },
          { name: 'Beams', guidance: 'Beam levels from front', parts: ['! Beam locks :: safety locks / pins visible in beam connectors', '! Beams :: no bent or deflected beams'] },
          { name: 'Load sign', guidance: 'Load notice at the end of the run', parts: ['Load notice :: safe working load sign displayed'] },
        ],
        general_parts: ['Pallets placed correctly :: pallets sitting on both beams, not overhanging badly'],
      },
    ],
  },
  {
    key: 'facilities', name: 'Facilities & real estate',
    templates: [
      {
        key: 'lift-cabin', name: 'Lift / elevator cabin', description: 'Monthly visual check of a passenger lift cabin',
        idLabel: 'Lift no.', safety: true, frequencyDays: 30,
        angles: [
          { name: 'Cabin inside', guidance: 'Inside the cabin facing the panel', parts: ['! Alarm button :: alarm / emergency button present', 'Lighting :: cabin lights working', 'Capacity plate :: capacity / persons plate displayed'] },
          { name: 'Door and landing', guidance: 'Landing door from outside', parts: ['Door :: door panels not damaged', 'Licence :: lift licence / AMC certificate displayed'] },
        ],
        general_parts: [],
      },
      {
        key: 'water-tank-pump', name: 'Water tank & pump room', description: 'Monthly check of overhead / underground tank and pump room',
        idLabel: 'Tank / pump room ID', safety: false, frequencyDays: 30,
        angles: [
          { name: 'Tank cover', guidance: 'Tank top with manhole cover', parts: ['Cover :: manhole cover closed and locked', 'No contamination :: no debris or dead insects around the opening'] },
          { name: 'Pumps', guidance: 'Pump sets and starter panel', parts: ['No leaks :: no water leaks at pump glands or pipes', 'Starter panel :: panel door closed', 'Pressure gauge :: gauge fitted'] },
        ],
        general_parts: ['Housekeeping :: room dry and clean'],
      },
      {
        key: 'common-area', name: 'Common area housekeeping', description: 'Daily check of lobbies, corridors and stairs',
        idLabel: 'Area / tower', safety: false, frequencyDays: 1,
        angles: [
          { name: 'Lobby', guidance: 'Entrance lobby wide view', parts: ['Floor clean :: floor clean and dry', 'Bins :: dustbins present and not overflowing'] },
          { name: 'Corridor / stairs', guidance: 'Corridor or staircase', parts: ['Clear route :: no stored items or obstructions', 'Lights :: corridor lights working'] },
        ],
        general_parts: [],
      },
    ],
  },
  {
    key: 'oil_gas', name: 'Oil, gas & chemicals',
    templates: [
      {
        key: 'gas-cylinder-store', name: 'Gas cylinder storage', description: 'Weekly check of a compressed gas cylinder store',
        idLabel: 'Store ID', safety: true, frequencyDays: 7,
        angles: [
          { name: 'Cylinders', guidance: 'Row of cylinders', parts: ['! Chained :: cylinders upright and secured with chain or rack', '! Valve caps :: protective caps on cylinders not in use'] },
          { name: 'Store area', guidance: 'Store entrance and signage', parts: ['Signage :: hazard / no smoking signs displayed', 'Segregation :: full and empty cylinders kept separate and marked'] },
        ],
        general_parts: ['Ventilation :: store is open / ventilated, not enclosed'],
      },
      {
        key: 'chemical-store', name: 'Chemical storage area', description: 'Weekly check of a chemical storage area',
        idLabel: 'Store ID', safety: true, frequencyDays: 7,
        angles: [
          { name: 'Shelving', guidance: 'Shelves with containers', parts: ['! Labels :: every container labelled with its contents', 'Closed containers :: containers closed with lids'] },
          { name: 'Spill and safety', guidance: 'Spill kit, eye wash and SDS', parts: ['! Spill kit :: spill kit present', 'Eye wash :: eye wash station present', 'SDS :: safety data sheets available'] },
        ],
        general_parts: ['Bunding :: liquids stored on a spill tray / bund'],
      },
    ],
  },
  {
    key: 'it_telecom', name: 'IT & telecom',
    templates: [
      {
        key: 'laptop-setup', name: 'Laptop setup', description: 'Laptop on desk with charger and USB device connected',
        idLabel: 'Asset tag', safety: false, frequencyDays: null,
        angles: [
          { name: 'Left side ports', guidance: 'Close-up of the left edge, ports and plugs clearly visible', parts: ['USB cable :: a USB cable plug is fully inserted into a USB port on the laptop', 'Charger cable :: the charger plug is inserted into the laptop charging port'] },
          { name: 'Screen on', guidance: 'Lid open, whole screen visible', parts: ['Screen on :: screen is switched on and showing an image', 'Screen damage :: no cracks, lines or dead areas on the screen'] },
        ],
        general_parts: ['Asset label :: asset or service tag label visible'],
      },
      {
        key: 'server-rack', name: 'Server rack', description: 'Monthly visual check of a server / network rack',
        idLabel: 'Rack ID', safety: false, frequencyDays: 30,
        angles: [
          { name: 'Front', guidance: 'Rack front, door open', parts: ['Status lights :: no amber / red fault lights on devices', 'Blanking panels :: empty U spaces covered with blanking panels'] },
          { name: 'Rear cabling', guidance: 'Rear of the rack', parts: ['Cable management :: cables tied and routed, not hanging loose', '! Power :: both power feeds connected to the PDUs'] },
        ],
        general_parts: ['Labels :: devices labelled'],
      },
    ],
  },
  {
    key: 'healthcare', name: 'Healthcare',
    templates: [
      {
        key: 'crash-cart', name: 'Crash cart', description: 'Daily check of an emergency crash cart',
        idLabel: 'Cart ID', safety: true, frequencyDays: 1,
        angles: [
          { name: 'Top of cart', guidance: 'Top surface with defibrillator', parts: ['! Defibrillator :: defibrillator present and plugged in / charging indicator on', 'Suction :: suction unit present'] },
          { name: 'Seal and log', guidance: 'Drawer seal and check log', parts: ['! Seal :: drawer tamper seal intact', 'Check log :: daily check log sheet attached'] },
        ],
        general_parts: ['Oxygen :: oxygen cylinder attached with gauge'],
      },
      {
        key: 'oxygen-cylinder', name: 'Oxygen cylinder', description: 'Check of a medical oxygen cylinder in use or in store',
        idLabel: 'Cylinder no.', safety: true, frequencyDays: 7,
        angles: [
          { name: 'Gauge and valve', guidance: 'Close-up of regulator and gauge', parts: ['! Gauge reading :: gauge needle above the refill mark', 'Regulator :: regulator fitted, no visible damage'] },
          { name: 'Cylinder and holder', guidance: 'Whole cylinder in its trolley / holder', parts: ['! Secured :: cylinder in a trolley or chained, upright', 'Label :: medical oxygen label readable'] },
        ],
        general_parts: [],
      },
    ],
  },
  {
    key: 'hospitality_retail', name: 'Hospitality, food & retail',
    templates: [
      {
        key: 'hotel-room', name: 'Hotel room readiness', description: 'Housekeeping check before a room is released',
        idLabel: 'Room no.', safety: false, frequencyDays: null,
        angles: [
          { name: 'Bed area', guidance: 'Wide view of the bed and side tables', parts: ['Bed made :: bed made, sheets smooth, no stains', 'Pillows :: pillows placed'] },
          { name: 'Bathroom', guidance: 'Bathroom wide view', parts: ['Clean :: basin, toilet and floor clean', 'Towels :: fresh towels placed', 'Amenities :: amenities kit placed'] },
        ],
        general_parts: ['No litter :: no litter or used items left in the room'],
      },
      {
        key: 'kitchen-hygiene', name: 'Commercial kitchen hygiene', description: 'Daily food-safety check of a commercial kitchen',
        idLabel: 'Kitchen / outlet', safety: true, frequencyDays: 1,
        angles: [
          { name: 'Prep area', guidance: 'Food preparation counters', parts: ['Surfaces clean :: counters clean, no food residue', 'Colour-coded boards :: separate chopping boards in use'] },
          { name: 'Cold storage', guidance: 'Fridge / cold room with thermometer', parts: ['! Temperature :: thermometer shows 5°C or below', 'Covered food :: stored food covered and labelled'] },
          { name: 'Staff and handwash', guidance: 'Handwash station', parts: ['Handwash :: soap and paper towels at the handwash station', 'Hairnets :: staff wearing caps / hairnets'] },
        ],
        general_parts: ['Pest :: no signs of pests'],
      },
      {
        key: 'retail-shelf', name: 'Retail shelf / planogram', description: 'Check a shelf against the planogram and display rules',
        idLabel: 'Store / aisle', safety: false, frequencyDays: 7,
        angles: [
          { name: 'Shelf front', guidance: 'Whole shelf bay from the front', parts: ['Fully stocked :: no empty facings / gaps', 'Price labels :: price labels present under products', 'Faced up :: products pulled forward and facing out'] },
        ],
        general_parts: ['Promo material :: promotional display / POS material in place'],
      },
    ],
  },
];

export function libraryTemplate(industryKey, templateKey) {
  const ind = INDUSTRIES.find((i) => i.key === industryKey);
  return ind?.templates.find((t) => t.key === templateKey) || null;
}

export function librarySummary() {
  return INDUSTRIES.map((i) => ({
    key: i.key, name: i.name,
    templates: i.templates.map((t) => ({
      key: t.key, name: t.name, description: t.description, safety: Boolean(t.safety),
      views: t.angles.length, checks: t.angles.reduce((n, a) => n + a.parts.length, 0) + (t.general_parts || []).length,
    })),
  }));
}
