classdef Pt
    properties
        x = 0
    end
    methods
        function obj = move(obj, d)
            obj.x = obj.x + d;
        end
    end
end
