local Players = game:GetService("Players")
local RunService = game:GetService("RunService")
local Workspace = game:GetService("Workspace")

local player = Players.LocalPlayer
local char = player.Character or player.CharacterAdded:Wait()
player.CharacterAdded:Connect(function(c) char = c end)

local FloatingGems = Workspace:WaitForChild("FloatingGems", 5)
local FloatingObjects = Workspace:WaitForChild("FloatingObjects", 5)

local ENABLED = true
local AURA_RADIUS = 30
local SCAN_EVERY = 0.08
local TOUCH_WAIT = 0.25
local RETURN_AFTER = true

local function hrp()
    return char and char:FindFirstChild("HumanoidRootPart")
end

local function hum()
    return char and char:FindFirstChildOfClass("Humanoid")
end

local function isCollectible(inst)
    if not inst or not inst:IsA("BasePart") then return false end
    if not inst:FindFirstChildOfClass("TouchTransmitter") then return false end
    return true
end

local function rootOf(inst)
    local m = inst:FindFirstAncestorOfClass("Model")
    if m and m.PrimaryPart then return m.PrimaryPart end
    return inst
end

local function nearestCollectible(origin)
    local best, bestDist
    local folders = {}
    if FloatingGems then folders[#folders+1] = FloatingGems end
    if FloatingObjects then folders[#folders+1] = FloatingObjects end
    for _, folder in ipairs(folders) do
        for _, d in ipairs(folder:GetDescendants()) do
            if isCollectible(d) then
                local p = d.Position
                local dist = (p - origin).Magnitude
                if dist <= AURA_RADIUS and (not bestDist or dist < bestDist) then
                    best, bestDist = d, dist
                end
            end
        end
    end
    return best, bestDist
end

local busy = false
local acc = 0
RunService.Heartbeat:Connect(function(dt)
    if not ENABLED or busy then return end
    acc += dt
    if acc < SCAN_EVERY then return end
    acc = 0

    local r = hrp()
    local h = hum()
    if not r or not h then return end

    local startPos = r.Position
    local targetPart = nearestCollectible(startPos)
    if not targetPart then return end

    busy = true
    local goal = rootOf(targetPart).Position + Vector3.new(0, 2, 0)
    h:MoveTo(goal)
    local t0 = time()
    repeat
        if (r.Position - goal).Magnitude < 2.5 then break end
        RunService.Heartbeat:Wait()
    until time() - t0 > TOUCH_WAIT

    if RETURN_AFTER then
        h:MoveTo(startPos)
    end

    busy = false
end)

-- live tuning examples:
-- ENABLED = false
-- AURA_RADIUS = 45
