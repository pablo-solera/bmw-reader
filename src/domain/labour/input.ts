export type LabourTypekeyInput = { typekey: string; series?: string; family: string; model?: string };

export type LabourInputBase = {
  axCode?: string;
  edition?: string;
  manufacturer: string;
  series?: string;
  model?: string;
  date: string;
  language?: string;
};

export type LabourInput = LabourInputBase & { typekeys: LabourTypekeyInput[] };
