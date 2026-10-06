/**
 * Skill ids, shared by the engine, the Armory and the house drill tools.
 *
 * An id is exactly the string Claude Code uses: `legion-armory:<name>` for a skill in the Armory's own plugin,
 * `<plugin>:<skill>` for a Claude Code plugin skill, and the bare name for a personal or built-in one. It is what the
 * SDK's `skills` option takes and what the Skill tool reports in `input.skill`. A drill (a house skill) has no SDK
 * identity, so its id is `drill:<group>/<folder>`.
 */
export const ARMORY_PLUGIN = 'legion-armory';
export const armoryId = (name: string): string => `${ARMORY_PLUGIN}:${name}`;
export const drillId = (group: string, folder: string): string => `drill:${group}/${folder}`.toLowerCase();
export const isDrillId = (id: string): boolean => id.startsWith('drill:');
/** Skill names Legion writes itself: lower case letters, digits and hyphens. */
/**
 * The longest description Legion keeps for a skill. A description goes into every agent's prompt (src/core/armory/catalog.ts), so the cap
 * is a prompt-size guard, not a display choice: the screen says so when a description was cut (descriptionCut in armory-view.ts).
 */
export const DESCRIPTION_CAP = 400;
export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** An agent's own skills setting: 'inherit' (or absent) means every skill the Armory switched on for it; a list chooses ids. */
export type AgentSkills = 'inherit' | string[] | undefined;

/** Whether the agent's own setting lets this id through. A list only narrows: it never turns a skill on. */
export function agentSkillsAllow(setting: AgentSkills, id: string): boolean {
  if (setting === undefined || setting === 'inherit') return true;
  const k = id.toLowerCase();
  return setting.some((x) => x.toLowerCase() === k);
}
