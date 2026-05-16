import { Response, NextFunction } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';
import { walletService } from '../services/wallet.service.js';

export function creditCheck(requiredCredits: number) {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const userId = req.userId;
      if (!userId) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }

      const sufficient = await walletService.hasSufficientCredits(userId, requiredCredits);
      if (!sufficient) {
        const balance = await walletService.getBalance(userId);
        res.status(402).json({
          error: 'Insufficient credits',
          requiredCredits,
          balance,
          shortfall: requiredCredits - balance,
        });
        return;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
