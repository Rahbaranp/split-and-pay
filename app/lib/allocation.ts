type AllocationPerson = { id: string };
type AllocationExpense = { cents: number; consumers: string[]; quantities?: Record<string, number> };

export function allocateExpenseTotals<T extends AllocationExpense>(items: T[], people: AllocationPerson[], totalFor: (item: T) => number) {
  const ideal: Record<string, number> = Object.fromEntries(people.map((person) => [person.id, 0]));
  let assignedTotal = 0;
  items.forEach((item) => {
    const consumers = people.filter((person) => item.consumers.includes(person.id));
    if (!consumers.length) return;
    const weights = consumers.map((person) => Math.max(1, Math.floor(item.quantities?.[person.id] || 1)));
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
    const itemTotal = totalFor(item);
    assignedTotal += itemTotal;
    consumers.forEach((person, index) => { ideal[person.id] += itemTotal * weights[index] / totalWeight; });
  });
  const result: Record<string, number> = Object.fromEntries(people.map((person) => [person.id, Math.floor(ideal[person.id] + 1e-9)]));
  let remainder = assignedTotal - Object.values(result).reduce((sum, cents) => sum + cents, 0);
  const order = people.filter((person) => ideal[person.id] > 0).map((person, index) => ({ id: person.id, fraction: ideal[person.id] - Math.floor(ideal[person.id]), index })).sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  for (let index = 0; remainder > 0 && order.length; index++, remainder--) result[order[index % order.length].id]++;
  return result;
}
