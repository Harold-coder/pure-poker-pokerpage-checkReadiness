const AWS = require('aws-sdk');
const dynamoDb = new AWS.DynamoDB.DocumentClient();
const eventBridge = new AWS.EventBridge();
const Helpers = require('UpdateGame');
const gameTableName = process.env.GAME_TABLE;
const connectionsTableName = process.env.CONNECTIONS_TABLE; // Table for WebSocket connections
const apiGatewayManagementApi = new AWS.ApiGatewayManagementApi({
    endpoint: process.env.WEBSOCKET_ENDPOINT // Set this environment variable to your WebSocket API endpoint.
});

exports.handler = async (event) => {
    const { gameId } = event.detail; // Assuming the gameId is passed in the detail field from the EventBridge rule

    try {
        const game = await getGameState(gameId);
        if (!game) {
            throw new Error("Game not found.");
        }

         // Check if all players are ready
        const allReady = game.players.every(p => p.isReady || p.chips < game.initialBigBlind);
        const readinessCountdownElapsed = new Date() - new Date(game.readinessCountdownStart) > 14999; // 15 seconds

        if (allReady || readinessCountdownElapsed) {
            resetGameState(game); // Reset game state and start a new round
            Helpers.setBlindsAndDeal(game);
        }

        await saveGameState(gameId, game);
        await notifyAllPlayers(gameId, game);

        await deleteTimerRule(`game-${gameId}-readiness-timer`); // Cleanup the EventBridge rule

        return { statusCode: 200, body: 'Timer is up, moving on.' };
    } catch (error) {
        console.error('Error checking game readiness:', error);
        await apiGatewayManagementApi.postToConnection({
            ConnectionId: connectionId,
            Data: JSON.stringify({ error: error.message })
        }).promise();

        return { statusCode: 500, body: JSON.stringify({ message: error.message }) };
    }
};

async function getGameState(gameId) {
    const params = {
        TableName: gameTableName,
        Key: { gameId },
    };
    const { Item } = await dynamoDb.get(params).promise();
    return Item;
}

async function saveGameState(gameId, game) {
    const params = {
        TableName: gameTableName,
        Key: { gameId },
        UpdateExpression: "SET players = :p, playerCount = :pc, smallBlindIndex = :sb, gameOverTimeStamp = :gOTS, bettingStarted = :bS, minRaiseAmount = :mRA, deck = :deck, pot = :pot, gameStage = :gs, currentTurn = :ct, communityCards = :cc, highestBet = :hb, gameInProgress = :gip, netWinners = :nw, waitingPlayers = :wp",
        ExpressionAttributeValues: {
            ":p": game.players,
            ":pc": game.playerCount,
            ":sb": game.smallBlindIndex,
            ":gOTS": game.gameOverTimeStamp,
            ":bS": game.bettingStarted,
            ":mRA": game.minRaiseAmount,
            ":pot": game.pot,
            ":gs": game.gameStage,
            ":ct": game.currentTurn,
            ":cc": game.communityCards,
            ":hb": game.highestBet,
            ":gip": game.gameInProgress,
            ":nw": game.netWinners,
            ":deck": game.deck,
            ":wp": game.waitingPlayers
        },
        ReturnValues: "UPDATED_NEW"
    };
    await dynamoDb.update(params).promise();
}

async function notifyAllPlayers(gameId, game) {
    // Retrieve all connection IDs for this game from the connections table
    const connectionData = await dynamoDb.scan({ TableName: connectionsTableName, FilterExpression: "gameId = :gameId", ExpressionAttributeValues: { ":gameId": gameId } }).promise();
    const postCalls = connectionData.Items.map(async ({ connectionId }) => {
        await apiGatewayManagementApi.postToConnection({ 
            ConnectionId: connectionId,
             Data: JSON.stringify({
                game: game,
                action: "checkReadiness",
                statusCode: 200
            }) 
        }).promise();
    });
    await Promise.all(postCalls); // hello
}

async function resetGameState(game) {
    if (!game) {
        throw new Error("Game not found");
    }

    // Filter players who are ready and have enough chips
    const activePlayers = game.players.filter(player => player.chips >= game.initialBigBlind);

    // Include waiting players if there's space available
    const spaceAvailable = game.maxPlayers - activePlayers.length;

    console.log(activePlayers);

    const newPlayersFromWaitingList = game.waitingPlayers.slice(0, spaceAvailable).map(playerId => ({
        id: playerId,
        position: game.players.length,
        chips: game.buyIn,
        isReady: true, // Assuming waiting players are ready to play
        bet: 0,
        inHand: true,
        isReady: false,
        hand: [],
        hasActed: false,
        potContribution: 0,
        isAllIn: false,
        amountWon: 0,
        handDescription: null,
        bestHand: null,
        readinessCountdownStarted: null
    }));

    // Combine the active players with the new players from the waiting list
    const updatedPlayers = [...activePlayers, ...newPlayersFromWaitingList];

    const newPlayerCount = updatedPlayers.length;

    if (newPlayerCount >= game.minPlayers) {
        // Update small blind index
        game.smallBlindIndex = (game.smallBlindIndex + 1) % newPlayerCount;
        
        // Update player states for the new game
        game.players = updatedPlayers.map((player, index) => ({
            ...player,
            bet: 0,
            position: index,
            isAllIn: false,
            hasActed: false,
            inHand: true,
            amountWon: 0,
            handDescription: null,
            isReady: false,
            potContribution: 0,
        }));

        // Remove seated players from the waitingPlayers list
        game.waitingPlayers = game.waitingPlayers.slice(spaceAvailable);


        // Reset the game state
        game.pot = 0;
        game.communityCards = [];
        game.currentTurn = game.smallBlindIndex;
        game.gameStage = 'preDealing';
        game.highestBet = 0;
        game.netWinners = [];
        game.gameInProgress = true;
        game.gameOverTimeStamp = null;
        game.minRaiseAmount = game.initialBigBlind;
        game.bettingStarted = false;
        game.playerCount = newPlayerCount;

    } else {
        console.log("Not enough players to start a new game.");
    }
}

async function deleteTimerRule(ruleName) {
    try {
        // Retrieve the rule's targets before deletion
        const targets = await eventBridge.listTargetsByRule({ Rule: ruleName }).promise();

        // Remove targets
        if (targets.Targets.length > 0) {
            await eventBridge.removeTargets({
                Rule: ruleName,
                Ids: targets.Targets.map(target => target.Id)
            }).promise();
        }

        // Delete the rule
        await eventBridge.deleteRule({ Name: ruleName }).promise();
    } catch (error) {
        console.error(`Failed to delete EventBridge rule ${ruleName}:`, error);
        // Handle error appropriately
    }
}
