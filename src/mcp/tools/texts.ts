import { addText, linkText, listTexts, updateText } from '../../data/repositories/texts.ts'
import {
  NewTextBulkSchema,
  NewTextSchema,
  TextLinkBulkSchema,
  TextLinkInputSchema,
  TextQuerySchema,
  TextUpdateSchema,
} from '../../schemas/texts.ts'
import { inOneTransaction } from '../bulk.ts'
import { defineTool, type ToolDefinition } from '../register.ts'

/** §11.1 group 6: the user's reusable texts (cover letters, outreach lines), kept as versions. */
export const textTools: ToolDefinition[] = [
  defineTool({
    name: 'text_list',
    title: 'List texts',
    description:
      'Lists the user\'s saved texts, one row per label showing its newest version, ordered by label. ' +
      'Give includeHistory: true to get every version of each label instead, newest first within a label, to read an earlier wording back. ' +
      'Give textTypeId to keep only the labels whose newest version has that type. ' +
      'Give postingId to list exactly the versions linked to that posting with text_link, the wording that was sent, even where the text has a newer version since; includeHistory changes nothing then, and an unknown posting is a not-found error. ' +
      'Use this to find a label before text_update, or to read a text; it takes no label, so filter the returned rows yourself.',
    input: TextQuerySchema,
    run: async (args, db) => listTexts(db, args),
  }),
  defineTool({
    name: 'text_add',
    title: 'Add a text',
    description:
      'Saves ONE new text under a label as version 1 and returns it as stored. ' +
      'The body is kept exactly as written, line breaks and indentation included. textTypeId is optional, and a text may have no type. ' +
      'Fails if the label already names a text, because new wording of an existing text is a new version: use text_update for that. ' +
      'Use text_add_bulk to save several at once.',
    input: NewTextSchema,
    run: async (args, db) => addText(db, args),
  }),
  defineTool({
    name: 'text_add_bulk',
    title: 'Add several texts',
    description:
      'Saves up to 500 new texts in one call, each as version 1 exactly as text_add takes it, and returns them as stored, in the order given. ' +
      'All or none: if any item fails (a label that already exists, including one repeated within the call, or an archived text type), nothing is saved and the error names the failing item by its index. ' +
      'Prefer this to repeated text_add calls when importing a set of texts.',
    input: NewTextBulkSchema,
    run: async (args, db) => inOneTransaction(db, args.items, (tx, item) => addText(tx, item)),
  }),
  defineTool({
    name: 'text_update',
    title: 'Write a new version of a text',
    description:
      'Writes new wording for an existing text, named by its label, as the next version, and returns that version. ' +
      'The earlier versions are kept and stay readable through text_list with includeHistory, so nothing is overwritten. ' +
      'Leave textTypeId out to keep the type of the latest version, give an id to change it, or give null to clear it. ' +
      'An unknown label is a not-found error: use text_add to create a text. ' +
      'If another write added a version of the same label first, this call fails with a conflict and writes nothing; read the text again with text_list and decide whether to repeat the edit.',
    input: TextUpdateSchema,
    run: async (args, db) => updateText(db, args),
  }),
  defineTool({
    name: 'text_link',
    title: 'Record which text was used for a posting',
    description:
      'Records that ONE version of a text, named by its row id (textAssetId, the id text_list returns), was used for ONE posting, and returns the link { textAssetId, postingId, linkedAt }. ' +
      'Link the version that was actually sent: a later text_update writes a new version and leaves this link on the old one. ' +
      'Linking the same version to the same posting again is a no-op that returns the first link. Read the links back with text_list and postingId. ' +
      'An unknown text version or posting is a not-found error.',
    input: TextLinkInputSchema,
    run: async (args, db) => linkText(db, args),
  }),
  defineTool({
    name: 'text_link_bulk',
    title: 'Record several text links',
    description:
      'Records up to 500 links in one call, each exactly as text_link takes it, and returns them in the order given. ' +
      'All or none: if any item fails, nothing is linked and the error names the failing item by its index. ' +
      'Prefer this to repeated text_link calls when importing which texts went to which postings.',
    input: TextLinkBulkSchema,
    run: async (args, db) => inOneTransaction(db, args.items, (tx, item) => linkText(tx, item)),
  }),
]
