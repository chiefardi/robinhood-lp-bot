import {z} from 'zod';
const proofSchema=z.object({tokenId:z.string().regex(/^\d+$/),closedAt:z.number().int().positive(),
 txHash:z.string().regex(/^0x[0-9a-f]{64}$/i),burnTx:z.string().regex(/^0x[0-9a-f]{64}$/i),blockNumber:z.number().int().positive()});
/** Nearby transfers are candidates only. Writes require independently reviewed exact receipts. */
export function assertReviewedCloseTime(candidate:unknown,reviewed:unknown):void {
 const p=proofSchema.parse(candidate),rows=z.array(proofSchema).parse(reviewed);
 const matching=rows.filter(r=>r.tokenId===p.tokenId);
 if(matching.length!==1||matching[0]!.closedAt!==p.closedAt||matching[0]!.blockNumber!==p.blockNumber||
    matching[0]!.txHash.toLowerCase()!==p.txHash.toLowerCase()||matching[0]!.burnTx.toLowerCase()!==p.burnTx.toLowerCase())throw new Error('Exact reviewed close receipt required; ambiguous or unreviewed sweep');
}
