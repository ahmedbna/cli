---
name: convex-types
description: Use when working with Convex TypeScript types — Doc, Id, Infer, FunctionReturnType. Trigger on "Doc type", "Id type", "Infer type", "function return type", "type safety", or when typing Convex data in React Native components and props.
---

# Convex TypeScript Types

## Document and ID types

```ts
import { Doc, Id } from "./_generated/dataModel";

type User = Doc<"users">;
type UserId = Id<"users">;

export const get = query({
  args: { id: v.id("users") },
  handler: async (ctx, { id }): Promise<User | null> => ctx.db.get(id),
});
```

## Using types in React Native

```tsx
import { Doc, Id } from "@/convex/_generated/dataModel";

interface Props {
  todo: Doc<"todos">;
  onToggle: (id: Id<"todos">) => void;
}

function TodoItem({ todo, onToggle }: Props) {
  return (
    <Pressable onPress={() => onToggle(todo._id)}>
      <AppText>{todo.text}</AppText>
    </Pressable>
  );
}
```

## Function return types

```ts
import { FunctionReturnType } from "convex/server";
import { api } from "./_generated/api";

// Infer the return type of a query
type TodoList = FunctionReturnType<typeof api.todos.list>;
```

## Validator to TypeScript type

```ts
import { Infer } from "convex/values";

const todoValidator = v.object({
  text: v.string(),
  completed: v.boolean(),
  priority: v.union(v.literal("low"), v.literal("medium"), v.literal("high")),
});

type Todo = Infer<typeof todoValidator>;
// { text: string; completed: boolean; priority: "low" | "medium" | "high" }
```
