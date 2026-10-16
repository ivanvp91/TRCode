/** Explicit delegation in the user's own request authorizes this turn only. */
export function delegationPreference(text: string): "allow" | "deny" | "unspecified" {
  const input = text.replace(/```[\s\S]*?```/g, "");
  const target = "(?:sub[ -]?agents?|субаг+ент[а-яё]*|помощник[а-яё]*|агент[а-яё]*)";
  const verb = "(?:запуст[а-яё]*|запуска[а-яё]*|использ[а-яё]*|подключ[а-яё]*|привлек[а-яё]*|привлеч[а-яё]*|поручи[а-яё]*|раздай[а-яё]*|spawn|launch|use|run|delegate|start)";
  const request = new RegExp(`(^|[^a-zа-яё])(${verb})[^.!?;\\n]{0,100}?${target}`, "gi");
  let preference: "allow" | "deny" | "unspecified" = "unspecified";
  for (const match of input.matchAll(request)) {
    const before = input.slice(0, match.index! + match[1].length);
    const denied = /(?:\b(?:do\s+not|don['’]t|never)|(?:^|\s)не)\s*$/i.test(before) || /\bno\s+sub[ -]?agents/i.test(match[0]);
    preference = denied ? "deny" : "allow";
  }
  if (preference === "unspecified" && /(?:без\s+субаг+ент[а-яё]*|\bwithout\s+sub[ -]?agents?)/i.test(input)) return "deny";
  return preference;
}

export function requestsSubagents(text: string): boolean {
  return delegationPreference(text) === "allow";
}
