import { Poll, PollOption, WebappDatabase } from "./database.ts";
import { logger } from "./main_lib.ts";

export class PollManager {
  private DB: WebappDatabase;

  constructor(db: WebappDatabase) {
    this.DB = db;
  }

  public castVote(pollId: number, userId: number, optionId: number, voteToken: string): { success: boolean; errorMsg?: string } {
    // 1. Hent token fra DB 
    const tokenFromDB = this.DB.getVoteToken(pollId, userId); 
    if (tokenFromDB.httpStatusCode !== 200) {
        return { success: false, errorMsg: "Vote token not found." };
    }

    // 2. Tjek token matcher  eller har været brugt før
    if (tokenFromDB.token !== voteToken) {
        return { success: false, errorMsg: "Invalid vote token." };
    }
    if (tokenFromDB.used === 1) {
        return { success: false, errorMsg: "Vote token already used." };
    }

    // 3. Marker som brugt i DB 
    this.DB.markTokenUsed(pollId, userId); 

    // 4. Indsæt Stemme i DB
    const voteId = crypto.randomUUID(); // Generer unikt ID for stemmen
    this.DB.insertVote(pollId, optionId, voteId);
    return {success: true};
  }

  public openPoll(pollId: number, userId: number): {poll: Poll; options: PollOption[]; voteToken: string} | null {
    // 1. Hent poll fra DB
    const { poll: pollFromDB, httpStatusCode: pollStatuscode } = this.DB.getPollFromDB(pollId);
    if (pollStatuscode !== 200) {
        logger.error(`Failed to retrieve poll with ID ${pollId} from database. Status code: ${pollStatuscode}`);
        return null;
    }

    // 2. Tjek om poll er lukket -> hvis den er det så skal den ikke åbnes
    if (!pollFromDB || pollFromDB.voteStatus !== "started") {
        logger.warn(`Attempted to open poll with ID ${pollId}, but it is closed.`);
            return null;
    }

    // 3. Hent polloptions fra DB 
    const optionsFromDB = this.DB.getPollOptionsFromDB(pollId);
    if (optionsFromDB.length === 0) {
        logger.warn(`No options found for poll with ID ${pollId}.`);
        return null;
    }

    // 4. createVotetoken 
    const voteToken = this.DB.createVoteToken(pollId, userId);
    if (voteToken.httpStatusCode !== 200 || !voteToken.token) {
        logger.error(`Failed to create vote token for poll ID ${pollId} and user ID ${userId}. Status code: ${voteToken.httpStatusCode}`);
        return null;
    }
    
    return { poll: pollFromDB, options: optionsFromDB, voteToken: voteToken.token };
  }


}
