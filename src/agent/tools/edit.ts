import { z } from 'zod';

export const editToolParameters = z.object({
  path: z.string().describe('The absolute path to the file to edit.'),
  old: z
    .string()
    .describe('The fragment of text to replace. Must be < 1024 characters.'),
  new: z
    .string()
    .describe('The new fragment of text. Must be < 1024 characters.'),
});

export const editTool = {
  description: 'Replace a unique string in a file with new text.',
  parameters: editToolParameters,
};
