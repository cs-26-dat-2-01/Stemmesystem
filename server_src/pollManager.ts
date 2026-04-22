import { Poll, PollOption, WebappDatabase } from "./database.ts";
import { logger } from "./main_lib.ts";

export class PollManager {
  private DB: WebappDatabase;

  constructor(db: WebappDatabase) {
    this.DB = db;
  }

  public async castVote(pollId: number, userId: number, optionId: number, UUID: string): Promise<{ success: boolean; errorMsg?: string }> {
    const pollResult = this.DB.getPollFromDB(pollId);
    // 1. First check if poll is open for voting
    if (pollResult.httpStatusCode !== 200 || !pollResult.poll) {
        return { success: false, errorMsg: "Poll not found." };
    }
    if (pollResult.poll.voteStatus !== "started") {
        return { success: false, errorMsg: "Voting is not open for this poll." };
    }

    
    // 2. check if user i eligble to vote 
    const eligible = this.DB.isUserEligible(pollId, userId); 
    if  (eligible === false) {
        return {success: false, errorMsg: "User not eliglbe"}; 
    }

    // 3. get UUID from database (remember Openpoll handles creation of UUID from user)
    const tokenFromDB = this.DB.getVoteToken(pollId, userId); 
    if (tokenFromDB.httpStatusCode !== 200) {
        return { success: false, errorMsg: "Vote token not found." };
    }

    // 4. Check to see if UUID matches or has been used before
    if (tokenFromDB.UUID !== UUID) {
        return { success: false, errorMsg: "Invalid vote token." };
    }
    if (tokenFromDB.used === 1) {
        return { success: false, errorMsg: "Vote token already used." };
    }
    // 5. get latest hash from DB and hash!
    const latestHashFromDB = this.DB.getLatestHash(pollId); 
    if (latestHashFromDB.httpStatusCode !== 200) {
        return {success: false, errorMsg: "Could not retrieve latest hash"}
    }
    const previousHash = latestHashFromDB.hash ?? "0"; 
    
    /* The following comments is way too extensive and will be moved to report after the code has been reviewed 
        We hash a string which consists of previous hash if no hash (first vote), its a 0. UUID, pollOptionId and pollId, between each value we have | 
        which is there because if we have pollOptionid: 1 and pollId: 11, and then have pollOptionId: 11 and pollId: 1, if there werent
        any seperating this would become the same string, and therefore there is a chance (small!) to get a first hash that is the same, however UUID would be unique, but still, we dont 
        wanna risk anything :P 

        */

    const hashMsg = `PreviousHash:${previousHash}|UUID:${UUID}|pollOptionId:${optionId}|pollId:${pollId}`;
    // We will use crypto.subtle.digest, but it doesnt take a string, it however takes a Uint8Array, so 
    // We converts our string to a Uint8Array so we can hash it
    const hashMsgBuffer = new TextEncoder().encode(hashMsg); 
    // we hash, and crypto.subtle.digest returns an arraybuffer
    const hashResultBuffer = await crypto.subtle.digest("SHA-256", hashMsgBuffer); 
    // convert the array first to an actually uint8Array and then we convert that to an actual array which consist of numbers.
    const hashnumberarray = Array.from(new Uint8Array(hashResultBuffer));
    /* SHA-256 produces 32 bytes, so we now have an array with 32 element, where each element is a nyumber between 0 and 255. SO for example we have:
    [227,176,196,....]
    We now need to convert it to a string, however we need to be careful however what we convert it to 
    if we simply converts it to UTF-8 we would run in to trouble, first for example byte-value 34 is " in ASCII/UTF-8 which could break our JSON but more
    importantly we get returned 0 255, but UTF-8 only the first 128 bytes is a single byte (to conserve backwards compability to ASCII, that means 129 in value is not actual correct UTF-8 )
    https://en.wikipedia.org/wiki/UTF-8#Examples
    Our hash produces random bytes, so around 50 % of them would be invalid UTF-8. We need to convert to something else and i have chosen hex, since every byte = 8 bits = 2 hex-characherters since hex can only be 0-9 and a-f.
    See https://www.rapidtables.com/convert/number/decimal-to-hex.html?x=44 
    so we use map which runs the callback func for every byte. We use tostring to convert our bytes to hex and we use padstart to ensure that we always have 2 characters of hex. 
    For example we can have byte 5, which is simply in hex 5, but we can then run into problems of creating the same hash so we want single charachter to be 05 instead. 
    We use .join to make one string out of our string[] array.
    */
    const currentHash = hashnumberarray.map(b => b.toString(16).padStart(2,"0")).join(""); 
    // 6. Insert vote
    const insertVote = this.DB.insertVote(pollId, optionId, UUID, previousHash, currentHash);
    if (insertVote.success === false && insertVote.httpStatusCode !== 200){
        logger.error(`Failed to insertVote with pollId ${pollId}, with optionId ${optionId}, voteId: ${UUID}, previousHash: ${previousHash} and currentHash: ${currentHash} httpStatuscode: ${insertVote.httpStatusCode}`);
        return {success: false, errorMsg: "Error while inserting vote"};
    }
    // 7. Mark token (UUID) as used in DB
    const markTokenUsed = this.DB.markTokenUsed(pollId, userId); 
    if (markTokenUsed.success === false && markTokenUsed.httpStatusCode !== 200){
        logger.error(`Failed to marktokenused, with pollId ${pollId}, userId: ${userId}, httpStatuscode: ${markTokenUsed.httpStatusCode}`);
        return {success: false, errorMsg: "Error while marking token as used"};
    }
    // 8. submit to audit log that the vote has been cast and how it has. 
    this.DB.insertAuditLog("VOTE_CAST", UUID, `pollId:${pollId},pollOptionId:${optionId}`);


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
